import type { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase.js'

const TELNYX_API = 'https://api.telnyx.com/v2'
const VOICEMAIL_DROP_URL = 'https://api.aeondial.com/static/VoicemailDrop.mp3'
const LIVE_ANSWER_IVR_URL = 'https://api.aeondial.com/static/LiveAnswerIVR.mp3'

type ClientState = {
  leg_type?: 'agent' | 'lead'
  call_id?: string
  lead_id?: string
  agent_id?: string
  lead_ids?: string[]
  caller_number?: string
  action?:
    | 'auto_voicemail'
    | 'manual_voicemail'
    | 'ivr_voicemail'
    | 'ivr_response'
    | 'bridged'
    | 'inbound'
    | 'inbound_agent'
    | 'inbound_record'
    | 'inbound_voicemail'
    | 'inbound_hold'
    | 'inbound_bridge'
    | 'failover_to_chris'
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

function isTerminalCallStatus(status?: string | null) {
  return ['completed', 'failed', 'no_answer', 'voicemail', 'abandoned'].includes(status ?? '')
}

function getPhoneNumber(value: any) {
  if (!value) return null
  if (typeof value === 'string') return value
  return value.phone_number ?? value.phoneNumber ?? value.number ?? null
}

function getGatherDigit(callData: any) {
  return String(callData?.digits ?? callData?.digit ?? callData?.gathered_digits ?? callData?.result ?? '').trim().slice(-1)
}

function getMachineDetectionResult(callData: any) {
  return String(callData?.result ?? callData?.machine_detection_result ?? callData?.answering_machine_detection_result ?? '').toLowerCase()
}

function buildAgentDialTarget(sipUsername: string): string {
  const fallbackDomain = process.env.AGENT_LEG_SIP_DOMAIN || 'aeondial.sip.telnyx.com'
  const normalizedUsername = sipUsername.trim().replace(/^sip:/, '').split('@')[0]
  return `sip:${normalizedUsername}@${fallbackDomain}`
}

async function findReadyAgent() {
  const { data: session } = await supabase
    .from('agent_sessions')
    .select('agent_id')
    .eq('state', 'READY')
    .is('active_call_id', null)
    .order('last_ready_at', { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  if (!session?.agent_id) return null

  const { data: agent } = await supabase
    .from('agents')
    .select('id, telnyx_sip_username')
    .eq('id', session.agent_id)
    .single()

  if (!agent?.telnyx_sip_username) return null
  return agent
}

async function dialReadyAgentForLead(leadCallControlId: string, callId: string, leadId?: string | null) {
  const agent = await findReadyAgent()
  if (!agent) return false

  const dial = await telnyxDial({
    connection_id: process.env.TELNYX_CONNECTION_ID,
    to: buildAgentDialTarget(agent.telnyx_sip_username),
    from: process.env.TELNYX_OUTBOUND_NUMBER,
    webhook_url: process.env.TELNYX_WEBHOOK_URL,
    link_to: leadCallControlId,
    bridge_intent: true,
    bridge_on_answer: true,
    prevent_double_bridge: true,
    client_state: encodeState({
      leg_type: 'agent',
      call_id: callId,
      agent_id: agent.id,
      lead_id: leadId ?? undefined,
      action: 'inbound_agent',
    }),
  })

  const agentLegId = dial.data?.call_control_id ?? dial.data?.callControlId
  if (!dial.ok || !agentLegId) return false

  const now = new Date().toISOString()
  await supabase
    .from('agent_sessions')
    .update({ state: 'RESERVED', active_call_id: callId, updated_at: now })
    .eq('agent_id', agent.id)

  await supabase
    .from('calls')
    .update({ agent_id: agent.id, agent_leg_id: agentLegId, status: 'agent_dialing' })
    .eq('id', callId)

  return true
}

async function bridgeLegs(agentLegId: string, leadCallControlId: string, callId: string) {
  return telnyxAction(agentLegId, 'bridge', {
    call_control_id: leadCallControlId,
    client_state: encodeState({ call_id: callId, action: 'bridged' }),
  })
}

async function bridgeReservedAgentToLead(call: any, leadCallControlId: string) {
  if (!call.agent_id || !call.agent_leg_id || isTerminalCallStatus(call.status)) return false

  const { data: agentSession } = await supabase
    .from('agent_sessions')
    .select('state')
    .eq('agent_id', call.agent_id)
    .single()

  const agentAvailable = agentSession?.state === 'RESERVED'
  if (!agentAvailable) return false

  const bridge = await bridgeLegs(call.agent_leg_id, leadCallControlId, call.id)
  if (!bridge.ok) return false

  const now = new Date().toISOString()
  await supabase
    .from('calls')
    .update({ status: 'bridged', lead_leg_id: leadCallControlId, answered_at: now, bridged_at: now })
    .eq('id', call.id)

  await supabase
    .from('agent_sessions')
    .update({ state: 'IN_CALL', active_call_id: call.id, updated_at: now })
    .eq('agent_id', call.agent_id)

  if (call.lead_id) {
    await supabase
      .from('leads')
      .update({ status: 'answered' })
      .eq('id', call.lead_id)
  }

  return true
}

async function dropVoicemail(callControlId: string, callId: string, leadId: string, action: 'auto_voicemail' | 'manual_voicemail' | 'ivr_voicemail' = 'auto_voicemail') {
  const now = new Date().toISOString()

  const { data: existingCall } = await supabase
    .from('calls')
    .select('id, status, voicemail_dropped, answered_at')
    .eq('id', callId)
    .single()

  if (!existingCall || existingCall.status === 'bridged' || existingCall.status === 'completed') {
    return false
  }

  if (existingCall.voicemail_dropped && action !== 'manual_voicemail') {
    return true
  }

  const playback = await telnyxAction(callControlId, 'playback_start', {
    audio_url: VOICEMAIL_DROP_URL,
    loop: 'once',
    client_state: encodeState({ call_id: callId, action }),
  })

  if (!playback.ok) {
    console.error(`[voicemail] Failed to start VM playback for call ${callId}`)
    return false
  }

  await supabase
    .from('calls')
    .update({
      status: 'voicemail',
      disposition: 'Voicemail',
      voicemail_dropped: true,
      voicemail_at: now,
      answered_at: existingCall.answered_at ?? now,
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
  return true
}

async function playLiveAnswerIvr(callControlId: string, callId: string, leadId?: string | null) {
  await telnyxAction(callControlId, 'gather_using_audio', {
    audio_url: LIVE_ANSWER_IVR_URL,
    gather_digits: '2',
    gather_timeout: 15,
    client_state: encodeState({
      call_id: callId,
      lead_id: leadId ?? undefined,
      action: 'ivr_response',
    }),
  })
}

async function markVoicemailAndHangup(callControlId: string, callId: string, leadId?: string | null) {
  if (leadId) {
    await dropVoicemail(callControlId, callId, leadId, 'ivr_voicemail')
  } else {
    await telnyxAction(callControlId, 'playback_start', {
      audio_url: VOICEMAIL_DROP_URL,
      loop: 'once',
      client_state: encodeState({ call_id: callId, action: 'ivr_voicemail' }),
    })
  }
}

async function saveInboundRecording(callData: any, clientState: ClientState) {
  const action = clientState.action
  if (action !== 'inbound_record' && action !== 'inbound_voicemail') return

  const recordingUrl =
    callData?.recording_url ??
    callData?.public_recording_url ??
    callData?.download_url ??
    callData?.recording_urls?.mp3 ??
    callData?.recording_urls?.wav ??
    null

  const callerNumber = clientState.caller_number ?? getPhoneNumber(callData?.from)
  const durationSeconds = callData?.duration_secs ?? callData?.duration_seconds ?? callData?.recording_duration_secs ?? null

  await supabase
    .from('inbound_messages')
    .insert({
      caller_number: callerNumber,
      recording_url: recordingUrl,
      duration_seconds: durationSeconds,
      created_at: new Date().toISOString(),
      handled: false,
    })
}

async function maybeReleaseBatchAgent(supabaseClient: any, groupId: string, agentId: string) {
  const activeStatuses = [
    'created',
    'agent_dialing',
    'agent_answered',
    'lead_dialing',
    'lead_answered',
    'bridged',
  ]

  const { data: siblingCalls } = await supabaseClient
    .from('calls')
    .select('id, status')
    .eq('group_id', groupId)
    .in('status', activeStatuses)

  if (siblingCalls && siblingCalls.length > 0) {
    console.log(`[BATCH] ${siblingCalls.length} sibling(s) still active — holding agent ${agentId}`)
    return
  }

  console.log(`[BATCH] All siblings resolved — releasing agent ${agentId} to READY`)
  await supabaseClient
    .from('agent_sessions')
    .update({ state: 'READY', active_call_id: null, updated_at: new Date().toISOString() })
    .eq('agent_id', agentId)
}

async function releaseAgentForCall(call: { group_id?: string | null; agent_id?: string | null }) {
  if (!call.agent_id) return

  if (call.group_id) {
    await maybeReleaseBatchAgent(supabase, call.group_id, call.agent_id)
    return
  }

  await supabase
    .from('agent_sessions')
    .update({ state: 'READY', active_call_id: null, updated_at: new Date().toISOString() })
    .eq('agent_id', call.agent_id)
}

export async function telnyxWebhookRoutes(app: FastifyInstance) {
  const handleTelnyxWebhook = async (req: any, reply: any) => {
    const payload = req.body as any
    const event = payload?.data?.event_type
    const callData = payload?.data?.payload

    if (!event || !callData) return reply.status(200).send({ ok: true })

    const callControlId = callData.call_control_id as string
    const clientState = decodeState(callData.client_state)

    console.log(`[webhook] ${event} | leg: ${callControlId} | type: ${clientState.leg_type ?? clientState.action ?? 'unknown'}`)

    switch (event) {
      case 'call.initiated': {
        const direction = callData.direction as string
        if (direction !== 'inbound') break

        const { data: readySession } = await supabase
          .from('agent_sessions')
          .select('agent_id, agents(telnyx_sip_username)')
          .eq('state', 'READY')
          .is('active_call_id', null)
          .limit(1)
          .single()

        if (readySession) {
          const sipUsername = (readySession as any).agents?.telnyx_sip_username
          const now = new Date().toISOString()

          await telnyxAction(callControlId, 'answer')
          await telnyxAction(callControlId, 'transfer', {
            to: `sip:${sipUsername}@aeondial.sip.telnyx.com`,
            webhook_url: process.env.TELNYX_WEBHOOK_URL,
            client_state: encodeState({ action: 'inbound_bridge', agent_id: readySession.agent_id }),
          })

          await supabase
            .from('agent_sessions')
            .update({ state: 'RESERVED', updated_at: now })
            .eq('agent_id', readySession.agent_id)

          await supabase.from('calls').insert({
            agent_id: readySession.agent_id,
            direction: 'inbound',
            status: 'agent_dialing',
            agent_leg_id: callControlId,
            started_at: now,
          })
        } else {
          await telnyxAction(callControlId, 'answer')
          await telnyxAction(callControlId, 'transfer', {
            to: '+18883682502',
            from: '+16232833337',
            webhook_url: process.env.TELNYX_WEBHOOK_URL,
            client_state: encodeState({ action: 'failover_to_chris' }),
          })
        }

        break
      }

      case 'call.answered': {
        if (clientState.leg_type === 'agent' && clientState.agent_id && clientState.call_id) {
          const now = new Date().toISOString()

          if (clientState.action === 'inbound_agent') {
            await supabase
              .from('agent_sessions')
              .update({ state: 'IN_CALL', active_call_id: clientState.call_id, updated_at: now })
              .eq('agent_id', clientState.agent_id)

            await supabase
              .from('calls')
              .update({ status: 'bridged', agent_leg_id: callControlId, answered_at: now, bridged_at: now })
              .eq('id', clientState.call_id)
            break
          }

          const leadIds = clientState.lead_ids ?? []
          await supabase
            .from('agent_sessions')
            .update({ state: 'RESERVED', active_call_id: clientState.call_id, updated_at: now })
            .eq('agent_id', clientState.agent_id)

          await supabase
            .from('calls')
            .update({ status: 'agent_answered', agent_leg_id: callControlId })
            .in('lead_id', leadIds)
            .eq('agent_id', clientState.agent_id)
            .in('status', ['created', 'agent_dialing'])

          const { data: calls } = await supabase
            .from('calls')
            .select('id, lead_id, leads(phone)')
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
            .select('id, lead_id, agent_id, group_id, agent_leg_id, status, answered_at')
            .eq('id', clientState.call_id)
            .single()

          if (!call) {
            await telnyxAction(callControlId, 'hangup')
            break
          }

          await supabase
            .from('calls')
            .update({ lead_leg_id: callControlId, answered_at: call.answered_at ?? now })
            .eq('id', call.id)

          const bridged = await bridgeReservedAgentToLead(call, callControlId)
          if (!bridged) {
            await playLiveAnswerIvr(callControlId, call.id, call.lead_id)
          }
        }

        break
      }

      case 'call.gather.ended':
      case 'call.dtmf.received': {
        if (clientState.action === 'ivr_response' && clientState.call_id) {
          const digit = getGatherDigit(callData)
          const now = new Date().toISOString()
          const { data: call } = await supabase
            .from('calls')
            .select('id, lead_id, agent_id, status')
            .eq('id', clientState.call_id)
            .single()

          if (!call) {
            await telnyxAction(callControlId, 'hangup')
            break
          }

          if (digit === '1') {
            const agentDialing = await dialReadyAgentForLead(callControlId, call.id, call.lead_id)
            if (!agentDialing) {
              await markVoicemailAndHangup(callControlId, call.id, call.lead_id)
            }
            break
          }

          if (digit === '2') {
            if (call.lead_id) {
              await supabase
                .from('leads')
                .update({ status: 'dnc', dnc_source: 'ivr_optout', dnc_at: now })
                .eq('id', call.lead_id)
            }

            await supabase
              .from('calls')
              .update({ disposition: 'Do Not Call', ended_at: now, wrapped_at: now })
              .eq('id', call.id)

            await telnyxAction(callControlId, 'hangup')
            break
          }

          await markVoicemailAndHangup(callControlId, call.id, call.lead_id)

          if (call.agent_id) {
            await supabase
              .from('agent_sessions')
              .update({
                state: 'READY',
                active_call_id: null,
                updated_at: new Date().toISOString(),
              })
              .eq('agent_id', call.agent_id)
          }
        }

        break
      }

      case 'call.machine.detection.ended': {
        if (getMachineDetectionResult(callData) === 'answering_machine' && clientState.call_id) {
          const { data: call } = await supabase
            .from('calls')
            .select('id, lead_id, status')
            .eq('id', clientState.call_id)
            .single()

          if (call?.lead_id && !isTerminalCallStatus(call.status) && call.status !== 'bridged') {
            await dropVoicemail(callControlId, call.id, call.lead_id, 'auto_voicemail')
          }
        }

        break
      }

      case 'call.playback.ended': {
        if (['auto_voicemail', 'ivr_voicemail', 'manual_voicemail'].includes(clientState.action ?? '') && clientState.call_id) {
          const now = new Date().toISOString()
          await telnyxAction(callControlId, 'hangup')
          await supabase
            .from('calls')
            .update({ ended_at: now, wrapped_at: now })
            .eq('id', clientState.call_id)

          if (clientState.action === 'auto_voicemail' || clientState.action === 'ivr_voicemail') {
            const { data: call } = await supabase
              .from('calls')
              .select('group_id, agent_id')
              .eq('id', clientState.call_id)
              .single()

            if (call) {
              await releaseAgentForCall(call)
            }
          }
        }

        break
      }

      case 'call.recording.saved':
      case 'call.recording.ended': {
        await saveInboundRecording(callData, clientState)
        break
      }

      case 'call.hangup': {
        const now = new Date().toISOString()

        if (clientState.leg_type === 'agent' && clientState.agent_id) {
          const { data: calls } = await supabase
            .from('calls')
            .select('id, lead_id, agent_id, group_id, status, lead_leg_id, answered_at')
            .eq('agent_leg_id', callControlId)
            .in('status', ['created', 'agent_dialing', 'agent_answered', 'lead_dialing', 'bridged'])

          for (const call of calls ?? []) {
            if (call.status === 'bridged') {
              if (call.lead_leg_id) await telnyxAction(call.lead_leg_id, 'hangup')
              await supabase
                .from('calls')
                .update({ status: 'completed', ended_at: now, wrapped_at: now })
                .eq('id', call.id)
            } else {
              await supabase
                .from('calls')
                .update({
                  status: call.lead_leg_id ? 'lead_dialing' : 'failed',
                  ended_at: call.lead_leg_id ? null : now,
                  wrapped_at: call.lead_leg_id ? null : now,
                })
                .eq('id', call.id)

              if (!call.lead_leg_id) await markLeadFailed(call.lead_id)
            }

            await releaseAgentForCall(call)
          }

          break
        }

        if (clientState.leg_type === 'lead' && clientState.call_id) {
          const { data: call } = await supabase
            .from('calls')
            .select('id, lead_id, agent_id, group_id, status, answered_at')
            .eq('id', clientState.call_id)
            .single()

          if (call && call.status !== 'completed' && call.status !== 'voicemail') {
            const completed = call.status === 'bridged'

            if (call.answered_at || completed) {
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

              await releaseAgentForCall(call)
            }
          }

          break
        }

        if (clientState.action === 'inbound_bridge' && clientState.agent_id) {
          await supabase
            .from('agent_sessions')
            .update({ state: 'READY', active_call_id: null, updated_at: now })
            .eq('agent_id', clientState.agent_id)
            .in('state', ['RESERVED', 'IN_CALL'])

          await supabase
            .from('calls')
            .update({ status: 'completed', ended_at: now, wrapped_at: now })
            .eq('agent_leg_id', callControlId)
            .eq('direction', 'inbound')
          break
        }

        if (clientState.action === 'failover_to_chris') break
        break
      }

      default:
        break
    }

    return reply.status(200).send({ ok: true })
  }

  app.post('/telnyx', handleTelnyxWebhook)
  app.post('/webhooks/telnyx', handleTelnyxWebhook)
}
