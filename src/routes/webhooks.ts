import type { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase.js'

const TELNYX_API = 'https://api.telnyx.com/v2'
const VM_URL = 'https://api.aeondial.com/static/Voicemailmessage.wav'

type ClientState = {
  leg_type?: 'agent' | 'lead'
  call_id?: string
  agent_id?: string
  lead_ids?: string[]
  action?: 'auto_voicemail'
}

function encodeState(state: ClientState) {
  return Buffer.from(JSON.stringify(state)).toString('base64')
}

function decodeState(raw?: string): ClientState {
  if (!raw) return {}
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
  } catch {
    return {}
  }
}

async function telnyxAction(callControlId: string, action: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${TELNYX_API}/calls/${callControlId}/actions/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error(`[telnyx] ${action} failed:`, err)
  }
  return res
}

async function telnyxDial(body: Record<string, unknown>) {
  const res = await fetch(`${TELNYX_API}/calls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
    },
    body: JSON.stringify(body),
  })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) console.error('[telnyx] dial failed:', json)
  return { ok: res.ok, data: json?.data ?? json }
}

async function markLeadFailed(leadId: string | null | undefined) {
  if (!leadId) return
  await supabase
    .from('leads')
    .update({ status: 'failed', assigned_agent_id: null })
    .eq('id', leadId)
}

async function dropVoicemail(callControlId: string, callId: string, leadId: string) {
  const now = new Date().toISOString()
  console.log(`[voicemail-auto] Dropping VM for call ${callId}`)

  await telnyxAction(callControlId, 'playback_start', {
    audio_url: VM_URL,
    loop: 'once',
    client_state: encodeState({ call_id: callId, action: 'auto_voicemail' }),
  })

  await supabase
    .from('calls')
    .update({
      status: 'voicemail',
      disposition: 'Voicemail',
      voicemail_dropped: true,
      voicemail_at: now,
      answered_at: now,
    })
    .eq('id', callId)

  await supabase
    .from('leads')
    .update({
      status: 'voicemail',
      assigned_agent_id: null,
      last_voicemail_at: now,
    })
    .eq('id', leadId)

  await supabase.rpc('increment', { row_id: leadId, col: 'voicemail_drop_count' })
}

export async function telnyxWebhookRoutes(app: FastifyInstance) {
  app.post('/telnyx', async (req, reply) => {
    const payload = req.body as any
    const event = payload?.data?.event_type
    const callData = payload?.data?.payload

    if (!event || !callData) return reply.status(200).send({ ok: true })

    const callControlId = callData.call_control_id as string
    const clientState = decodeState(callData.client_state)

    console.log(`[webhook] ${event} | leg: ${callControlId} | type: ${clientState.leg_type ?? clientState.action ?? 'unknown'}`)

    switch (event) {
      case 'call.answered': {
        if (clientState.leg_type === 'agent' && clientState.agent_id && clientState.call_id) {
          const leadIds = clientState.lead_ids ?? []
          const now = new Date().toISOString()

          await supabase
            .from('agent_sessions')
            .update({
              state: 'IN_CALL',
              active_call_id: clientState.call_id,
              updated_at: now,
            })
            .eq('agent_id', clientState.agent_id)

          await supabase
            .from('calls')
            .update({ status: 'agent_answered', agent_leg_id: callControlId, answered_at: now })
            .in('lead_id', leadIds)
            .eq('agent_id', clientState.agent_id)
            .in('status', ['created', 'agent_dialing'])

          const { data: calls } = await supabase
            .from('calls')
            .select('id, lead_id, campaign_id, group_id, leads(phone)')
            .in('lead_id', leadIds)
            .eq('agent_id', clientState.agent_id)
            .in('status', ['agent_answered'])

          for (const call of calls ?? []) {
            const phone = (call as any).leads?.phone
            if (!phone) {
              await markLeadFailed(call.lead_id)
              continue
            }

            const leadDial = await telnyxDial({
              connection_id: process.env.TELNYX_CONNECTION_ID,
              to: phone,
              from: process.env.TELNYX_OUTBOUND_NUMBER,
              webhook_url: process.env.TELNYX_WEBHOOK_URL,
              link_to: callControlId,
              bridge_intent: true,
              bridge_on_answer: true,
              prevent_double_bridge: true,
              answering_machine_detection: 'detect',
              client_state: encodeState({
                leg_type: 'lead',
                call_id: call.id,
                agent_id: clientState.agent_id,
              }),
            })

            const leadLegId = leadDial.data?.call_control_id ?? leadDial.data?.callControlId
            if (leadDial.ok && leadLegId) {
              await supabase
                .from('calls')
                .update({ status: 'lead_dialing', lead_leg_id: leadLegId })
                .eq('id', call.id)
            } else {
              await supabase
                .from('calls')
                .update({ status: 'failed', ended_at: new Date().toISOString(), wrapped_at: new Date().toISOString() })
                .eq('id', call.id)
              await markLeadFailed(call.lead_id)
            }
          }
          break
        }

        if (clientState.leg_type === 'lead' && clientState.call_id) {
          const now = new Date().toISOString()
          const { data: call } = await supabase
            .from('calls')
            .select('id, lead_id, agent_id, group_id, agent_leg_id, status')
            .eq('id', clientState.call_id)
            .single()

          if (!call) {
            await telnyxAction(callControlId, 'hangup')
            break
          }

          const { data: alreadyBridged } = await supabase
            .from('calls')
            .select('id')
            .eq('group_id', call.group_id)
            .eq('status', 'bridged')
            .neq('id', call.id)
            .limit(1)

          if (alreadyBridged && alreadyBridged.length > 0) {
            if (call.lead_id) await dropVoicemail(callControlId, call.id, call.lead_id)
            else await telnyxAction(callControlId, 'hangup')
            break
          }

          await supabase
            .from('calls')
            .update({ status: 'bridged', lead_leg_id: callControlId, answered_at: now })
            .eq('id', call.id)

          if (call.lead_id) {
            await supabase
              .from('leads')
              .update({ status: 'answered' })
              .eq('id', call.lead_id)
          }

          const { data: siblings } = await supabase
            .from('calls')
            .select('id, lead_id, lead_leg_id')
            .eq('group_id', call.group_id)
            .neq('id', call.id)
            .in('status', ['created', 'agent_answered', 'lead_dialing'])

          for (const sibling of siblings ?? []) {
            if (sibling.lead_leg_id) await telnyxAction(sibling.lead_leg_id, 'hangup')
            await supabase
              .from('calls')
              .update({ status: 'abandoned', ended_at: now, wrapped_at: now })
              .eq('id', sibling.id)
            await markLeadFailed(sibling.lead_id)
          }
          break
        }

        break
      }

      case 'call.playback.ended': {
        if (clientState.action === 'auto_voicemail' && clientState.call_id) {
          const now = new Date().toISOString()
          await telnyxAction(callControlId, 'hangup')
          await supabase
            .from('calls')
            .update({ status: 'completed', ended_at: now, wrapped_at: now })
            .eq('id', clientState.call_id)
          console.log(`[voicemail-auto] VM playback complete, call ${clientState.call_id} closed`)
        }
        break
      }

      case 'call.hangup': {
        const now = new Date().toISOString()

        if (clientState.leg_type === 'agent' && clientState.agent_id) {
          const { data: calls } = await supabase
            .from('calls')
            .select('id, lead_id, status, lead_leg_id')
            .eq('agent_leg_id', callControlId)
            .in('status', ['created', 'agent_dialing', 'agent_answered', 'lead_dialing', 'bridged'])

          const bridged = (calls ?? []).some((call) => call.status === 'bridged')
          for (const call of calls ?? []) {
            if (call.lead_leg_id) await telnyxAction(call.lead_leg_id, 'hangup')
            await supabase
              .from('calls')
              .update({ status: bridged ? 'completed' : 'failed', ended_at: now, wrapped_at: now })
              .eq('id', call.id)
            if (!bridged) await markLeadFailed(call.lead_id)
          }

          await supabase
            .from('agent_sessions')
            .update({ state: bridged ? 'WRAP_UP' : 'REGISTERED', active_call_id: null, updated_at: now })
            .eq('agent_id', clientState.agent_id)
          break
        }

        if (clientState.leg_type === 'lead' && clientState.call_id) {
          const { data: call } = await supabase
            .from('calls')
            .select('id, lead_id, agent_id, status')
            .eq('id', clientState.call_id)
            .single()

          if (call && call.status !== 'completed' && call.status !== 'voicemail') {
            const completed = call.status === 'bridged'
            await supabase
              .from('calls')
              .update({ status: completed ? 'completed' : 'no_answer', ended_at: now, wrapped_at: completed ? null : now })
              .eq('id', call.id)

            if (call.lead_id && !completed) {
              await supabase
                .from('leads')
                .update({ status: 'no_answer', assigned_agent_id: null })
                .eq('id', call.lead_id)
            }

            if (call.agent_id && completed) {
              await supabase
                .from('agent_sessions')
                .update({ state: 'WRAP_UP', active_call_id: null, updated_at: now })
                .eq('agent_id', call.agent_id)
            }
          }
          break
        }

        break
      }

      default:
        break
    }

    return reply.status(200).send({ ok: true })
  })
}
