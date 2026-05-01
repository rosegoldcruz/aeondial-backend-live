import type { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase.js'
import { redis } from '../lib/redis.js'
import { dialQueue } from '../lib/dialQueue.js'

const POST_RELEASE_COOLDOWN_MS = 2000

async function setAgentCooldown(agentId: string, ms = POST_RELEASE_COOLDOWN_MS) {
  await redis.set(`dialer:agent:${agentId}:locked`, '1', 'PX', ms)
}

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

  // ── ATOMIC: Atomically mark agent as RESERVED with RETURNING
  const { data: reservedAgent, error: reserveError } = await supabase
    .from('agent_sessions')
    .update({ state: 'RESERVED', active_call_id: callId, updated_at: now })
    .eq('agent_id', agent.id)
    .eq('state', 'READY') // guard: only if still READY
    .select('agent_id')
    .single()

  if (!reservedAgent) {
    console.warn(`[dialReadyAgent] Agent ${agent.id} no longer READY — skipping`)
    return false
  }

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
  console.log('[OVERFLOW_IVR] starting live answer IVR', {
    call_id: callId,
    lead_id: leadId ?? null,
    lead_call_control_id: callControlId,
    audio_url: LIVE_ANSWER_IVR_URL,
  })

  const ivr = await telnyxAction(callControlId, 'gather_using_audio', {
    audio_url: LIVE_ANSWER_IVR_URL,
    gather_digits: '2',
    gather_timeout: 15,
    client_state: encodeState({
      call_id: callId,
      lead_id: leadId ?? undefined,
      action: 'ivr_response',
    }),
  })

  console.log('[IVR_START_RESULT]', {
    call_id: callId,
    lead_id: leadId ?? null,
    ok: ivr.ok,
    status: ivr.status,
  })

  return ivr
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
  try {
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

    // Immediately re-queue next batch — don't wait for tick
    try {
      const { data: freshSession } = await supabaseClient.from('agent_sessions')
        .select('id')
        .eq('agent_id', agentId)
        .single()
      if (freshSession) {
        await dialQueue.add('dial-next', {
          agentId,
          sessionId: freshSession.id,
          batchSize: 2
        }, { priority: 1, jobId: `immediate-${agentId}-${Date.now()}` })
        console.log(`[BATCH] Immediately re-queued dial for agent ${agentId}`)
      }
    } catch (requeueErr) {
      console.error(`[BATCH] Failed to re-queue for agent ${agentId}:`, requeueErr)
    }
  } catch (err) {
    console.error(`[BATCH] maybeReleaseBatchAgent error for agent ${agentId}:`, err)
    // Fallback: release agent directly to avoid it being stuck until healer fires
    try {
      await supabaseClient
        .from('agent_sessions')
        .update({ state: 'READY', active_call_id: null, updated_at: new Date().toISOString() })
        .eq('agent_id', agentId)

      // Immediately re-queue next batch — don't wait for tick
      try {
        const { data: freshSession } = await supabaseClient.from('agent_sessions')
          .select('id')
          .eq('agent_id', agentId)
          .single()
        if (freshSession) {
          await dialQueue.add('dial-next', {
            agentId,
            sessionId: freshSession.id,
            batchSize: 2
          }, { priority: 1, jobId: `immediate-${agentId}-${Date.now()}` })
          console.log(`[BATCH] Immediately re-queued dial for agent ${agentId}`)
        }
      } catch (requeueErr) {
        console.error(`[BATCH] Failed to re-queue for agent ${agentId}:`, requeueErr)
      }
    } catch (fallbackErr) {
      console.error(`[BATCH] Fallback release also failed for agent ${agentId}:`, fallbackErr)
    }
  }
}

async function releaseAgentForCall(call: { group_id?: string | null; agent_id?: string | null }) {
  if (!call.agent_id) return

  if (call.group_id) {
    await maybeReleaseBatchAgent(supabase, call.group_id, call.agent_id)
    return
  }

  const agentId = call.agent_id
  await supabase
    .from('agent_sessions')
    .update({ state: 'READY', active_call_id: null, updated_at: new Date().toISOString() })
    .eq('agent_id', agentId)

  // Immediately re-queue next batch — don't wait for tick
  try {
    const { data: freshSession } = await supabase.from('agent_sessions')
      .select('id')
      .eq('agent_id', agentId)
      .single()
    if (freshSession) {
      await dialQueue.add('dial-next', {
        agentId,
        sessionId: freshSession.id,
        batchSize: 2
      }, { priority: 1, jobId: `immediate-${agentId}-${Date.now()}` })
      console.log(`[BATCH] Immediately re-queued dial for agent ${agentId}`)
    }
  } catch (requeueErr) {
    console.error(`[BATCH] Failed to re-queue for agent ${agentId}:`, requeueErr)
  }
}

export async function telnyxWebhookRoutes(app: FastifyInstance) {
  const handleTelnyxWebhook = async (req: any, reply: any) => {
    const payload = req.body as any
    const event = payload?.data?.event_type
    const callData = payload?.data?.payload

    // ── DEDUPLICATION: prevent double-execution on Telnyx retries ──
    const telnyxEventId = payload?.id ?? payload?.data?.event_id
    if (telnyxEventId) {
      try {
        // Attempt INSERT into webhook_dedup — if it conflicts (duplicate key), we've seen this before
        await supabase.from('webhook_dedup').insert({ id: telnyxEventId })
        // Insert succeeded, this is a new event — continue processing
      } catch (err: any) {
        // Likely a UNIQUE constraint violation (duplicate key) — we've already processed this event
        const isDuplicateKey = err?.code === '23505' || err?.message?.includes('duplicate key') || err?.message?.includes('unique')
        if (isDuplicateKey) {
          console.log(`[webhook] Duplicate event detected: ${telnyxEventId} — ignoring`)
          return reply.status(200).send({ ok: true })
        }
        // Log unexpected errors but continue (table may not exist yet)
        console.error(`[webhook] Dedup insert error (non-duplicate):`, err)
      }

      // Async cleanup: delete dedup entries older than 24 hours (fire-and-forget)
      setImmediate(async () => {
        try {
          await supabase
            .from('webhook_dedup')
            .delete()
            .lt('received_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        } catch (err) {
          console.error('[webhook] Cleanup error:', err)
        }
      })
    }

    if (!event || !callData) return reply.status(200).send({ ok: true })

    const callControlId = callData.call_control_id as string
    const clientState = decodeState(callData.client_state)

    console.log(`[webhook] ${event} | leg: ${callControlId} | type: ${clientState.leg_type ?? clientState.action ?? 'unknown'}`)

    // All webhook processing logic moved into setImmediate for instant ACK
    setImmediate(async () => {

    switch (event) {
      case 'call.initiated': {
        const direction = callData.direction as string
        if (direction !== 'inbound') break

        // ── ATOMIC: Atomically reserve an inbound-ready agent with RETURNING
        const { data: reservedSessions } = await supabase
          .from('agent_sessions')
          .update({ state: 'RESERVED', updated_at: new Date().toISOString() })
          .eq('state', 'READY')
          .is('active_call_id', null)
          .order('last_ready_at', { ascending: true, nullsFirst: false })
          .limit(1)
          .select('agent_id, agents(telnyx_sip_username)')
          .single()

        if (reservedSessions) {
          const sipUsername = (reservedSessions as any).agents?.telnyx_sip_username
          const now = new Date().toISOString()

          await telnyxAction(callControlId, 'answer')
          await telnyxAction(callControlId, 'transfer', {
            to: `sip:${sipUsername}@aeondial.sip.telnyx.com`,
            webhook_url: process.env.TELNYX_WEBHOOK_URL,
            client_state: encodeState({ action: 'inbound_bridge', agent_id: reservedSessions.agent_id }),
          })

          await supabase.from('calls').insert({
            agent_id: reservedSessions.agent_id,
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
            const { count: inCallCount } = await supabase
              .from('agent_sessions')
              .update({ state: 'IN_CALL', active_call_id: clientState.call_id, updated_at: now })
              .eq('agent_id', clientState.agent_id)
              .eq('state', 'RESERVED')
            if (!inCallCount) console.warn(`[webhook] Agent ${clientState.agent_id} state IN_CALL rejected`)

            await supabase
              .from('calls')
              .update({ status: 'bridged', agent_leg_id: callControlId, answered_at: now, bridged_at: now })
              .eq('id', clientState.call_id)
            break
          }

          let leadIds = Array.isArray(clientState.lead_ids)
            ? clientState.lead_ids.filter(Boolean)
            : []

          console.log('[AGENT_ANSWERED] incoming', {
            callControlId,
            agent_id: clientState.agent_id,
            call_id: clientState.call_id,
            leadIdsFromClientState: leadIds,
          })

          const { data: reservedRows, error: reservedErr } = await supabase
            .from('agent_sessions')
            .update({
              state: 'RESERVED',
              active_call_id: clientState.call_id,
              updated_at: now,
            })
            .eq('agent_id', clientState.agent_id)
            .in('state', ['REGISTERED', 'READY', 'RESERVED'])
            .select('id, agent_id, state, active_call_id')

          if (reservedErr) {
            console.error('[AGENT_ANSWERED] RESERVED update error:', reservedErr)
          }

          if (!reservedRows?.length) {
            console.warn('[AGENT_ANSWERED] RESERVED update matched zero rows', {
              agent_id: clientState.agent_id,
              call_id: clientState.call_id,
            })
          }

          if (leadIds.length === 0) {
            const { data: primaryCall, error: primaryErr } = await supabase
              .from('calls')
              .select('id, lead_id, group_id, agent_id, status')
              .eq('id', clientState.call_id)
              .single()

            if (primaryErr) {
              console.error('[AGENT_ANSWERED] primary call lookup failed:', primaryErr)
            }

            if (primaryCall?.group_id) {
              const { data: siblingCalls, error: siblingErr } = await supabase
                .from('calls')
                .select('id, lead_id, status, agent_id, group_id')
                .eq('group_id', primaryCall.group_id)
                .eq('agent_id', clientState.agent_id)
                .in('status', ['created', 'agent_dialing', 'agent_answered'])

              if (siblingErr) {
                console.error('[AGENT_ANSWERED] sibling call lookup failed:', siblingErr)
              }

              leadIds = (siblingCalls ?? []).map((c: any) => c.lead_id).filter(Boolean)

              console.log('[AGENT_ANSWERED] recovered leadIds from group', {
                group_id: primaryCall.group_id,
                count: leadIds.length,
                leadIds,
              })
            } else if (primaryCall?.lead_id) {
              leadIds = [primaryCall.lead_id]
            }
          }

          if (leadIds.length === 0) {
            console.error('[LEAD_DIAL_BLOCKED] no leadIds after clientState + DB recovery', {
              callControlId,
              clientState,
            })
            break
          }

          const { data: answeredCalls, error: answeredErr } = await supabase
            .from('calls')
            .update({
              status: 'agent_answered',
              agent_leg_id: callControlId,
            })
            .in('lead_id', leadIds)
            .eq('agent_id', clientState.agent_id)
            .in('status', ['created', 'agent_dialing', 'agent_answered'])
            .select('id, lead_id, status, agent_id, group_id')

          if (answeredErr) {
            console.error('[AGENT_ANSWERED] failed to mark calls agent_answered:', answeredErr)
          }

          console.log('[AGENT_ANSWERED] matched calls', {
            count: answeredCalls?.length ?? 0,
            leadIds,
            calls: answeredCalls,
          })

          if (!answeredCalls?.length) {
            console.error('[LEAD_DIAL_BLOCKED] no calls matched agent_answered update', {
              agent_id: clientState.agent_id,
              leadIds,
              callControlId,
            })
            break
          }

          const answeredCallIds = answeredCalls.map((c: any) => c.id).filter(Boolean)

          const { data: calls, error: callsErr } = await supabase
            .from('calls')
            .select('id, lead_id, agent_id, status, group_id, leads(phone)')
            .in('id', answeredCallIds)

          if (callsErr) {
            console.error('[AGENT_ANSWERED] failed to select calls for lead dialing:', callsErr)
          }

          console.log('[AGENT_ANSWERED] calls selected for lead dialing', {
            count: calls?.length ?? 0,
            calls: (calls ?? []).map((c: any) => ({
              id: c.id,
              lead_id: c.lead_id,
              status: c.status,
              phone: Array.isArray(c.leads) ? c.leads[0]?.phone : c.leads?.phone,
            })),
          })

          if (!calls?.length) {
            console.error('[LEAD_DIAL_BLOCKED] zero calls selected for lead dialing', {
              answeredCallIds,
            })
            break
          }

          await Promise.all((calls ?? []).map(async (call: any) => {
            const leadsRelation = call.leads
            const phone = Array.isArray(leadsRelation)
              ? leadsRelation[0]?.phone
              : leadsRelation?.phone

            if (!phone) {
              console.error('[LEAD_DIAL_BLOCKED] missing lead phone', {
                call_id: call.id,
                lead_id: call.lead_id,
                leadsRelation,
              })
              await markLeadFailed(call.lead_id)
              return
            }

            console.log('[LEAD_DIAL_ATTEMPT]', {
              call_id: call.id,
              lead_id: call.lead_id,
              to: phone,
              from: process.env.TELNYX_OUTBOUND_NUMBER,
              hasConnectionId: !!process.env.TELNYX_CONNECTION_ID,
              webhook_url: process.env.TELNYX_WEBHOOK_URL,
            })

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

            console.log('[LEAD_DIAL_RESULT]', {
              call_id: call.id,
              ok: leadDial.ok,
              leadLegId,
              data: leadDial.data,
            })

            if (leadDial.ok && leadLegId) {
              const { data: leadLegRows, error: leadLegErr } = await supabase
                .from('calls')
                .update({
                  status: 'lead_dialing',
                  lead_leg_id: leadLegId,
                })
                .eq('id', call.id)
                .select('id, status, lead_leg_id')

              if (leadLegErr) {
                console.error('[LEAD_DIAL_RESULT] failed to persist lead_leg_id:', leadLegErr)
              }

              console.log('[LEAD_DIAL_RESULT] persisted lead_leg_id', {
                call_id: call.id,
                leadLegId,
                rows: leadLegRows,
              })
            } else {
              console.error('[LEAD_DIAL_FAILED]', {
                call_id: call.id,
                lead_id: call.lead_id,
                leadDial,
              })

              await supabase
                .from('calls')
                .update({
                  status: 'failed',
                  ended_at: new Date().toISOString(),
                  wrapped_at: new Date().toISOString(),
                })
                .eq('id', call.id)

              await markLeadFailed(call.lead_id)

              // If lead dialing fails at the provider layer, do not strand the agent.
              // Let the existing sibling resolver release the agent back to READY
              // once the whole predictive batch has no active lead legs left.
              await releaseAgentForCall(call)
            }
          }))

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
            console.log('[OVERFLOW_IVR] lead answered but agent unavailable; using IVR fallback', {
              call_id: call.id,
              lead_id: call.lead_id,
              agent_id: call.agent_id,
              previous_status: call.status,
              lead_call_control_id: callControlId,
            })
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

          console.log('[IVR_RESPONSE]', {
            call_id: call.id,
            lead_id: call.lead_id,
            agent_id: call.agent_id,
            digit,
            event,
          })

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
            const agentId = call.agent_id
            await supabase
              .from('agent_sessions')
              .update({
                state: 'READY',
                active_call_id: null,
                updated_at: new Date().toISOString(),
              })
              .eq('agent_id', agentId)

            // Immediately re-queue next batch — don't wait for tick
            try {
              const { data: freshSession } = await supabase.from('agent_sessions')
                .select('id')
                .eq('agent_id', agentId)
                .single()
              if (freshSession) {
                await dialQueue.add('dial-next', {
                  agentId,
                  sessionId: freshSession.id,
                  batchSize: 2
                }, { priority: 1, jobId: `immediate-${agentId}-${Date.now()}` })
                console.log(`[BATCH] Immediately re-queued dial for agent ${agentId}`)
              }
            } catch (requeueErr) {
              console.error(`[BATCH] Failed to re-queue for agent ${agentId}:`, requeueErr)
            }
          }
        }

        break
      }

      case 'call.machine.detection.ended': {
        if (getMachineDetectionResult(callData) === 'answering_machine' && clientState.call_id) {
          const { data: call } = await supabase
            .from('calls')
            .select('id, lead_id, status, agent_id, agent_leg_id')
            .eq('id', clientState.call_id)
            .single()

          if (call?.lead_id && !isTerminalCallStatus(call.status) && call.status !== 'bridged') {
            // ── AMD NO BLIND DROP: Check if READY agent available ──
            // If agent exists, bridge instead of blind drop
            if (call.agent_id && call.agent_leg_id && call.status === 'lead_dialing') {
              const bridged = await bridgeReservedAgentToLead(call, callControlId)
              if (bridged) {
                console.log(`[AMD] Machine detected but agent available — bridging call ${call.id}`)
                break
              }
            }

            // No agent available or bridge failed — drop voicemail
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
              if (call.agent_id) await setAgentCooldown(call.agent_id)
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
              if (call.lead_leg_id) {
                // Agent dropped before bridge but lead leg exists (lead is ringing or answered).
                // Hang up the lead leg immediately — don't leave the lead on a dead line.
                await telnyxAction(call.lead_leg_id, 'hangup')
                await supabase
                  .from('calls')
                  .update({ status: 'failed', ended_at: now, wrapped_at: now })
                  .eq('id', call.id)
                await markLeadFailed(call.lead_id)
              } else {
                await supabase
                  .from('calls')
                  .update({ status: 'failed', ended_at: now, wrapped_at: now })
                  .eq('id', call.id)
                await markLeadFailed(call.lead_id)
              }
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
              // Cooldown after no-answer: prevent ticker from immediately re-queuing the same agent
              if (!completed && call.agent_id) await setAgentCooldown(call.agent_id)
            }
          }

          break
        }

        if (clientState.action === 'inbound_bridge' && clientState.agent_id) {
          const { count: releaseCount } = await supabase
            .from('agent_sessions')
            .update({ state: 'READY', active_call_id: null, updated_at: now })
            .eq('agent_id', clientState.agent_id)
            .in('state', ['RESERVED', 'IN_CALL'])
          if (!releaseCount) console.warn(`[webhook] Agent ${clientState.agent_id} READY release rejected`)
            // Immediately re-queue next batch — don't wait for tick
            const agentIdInbound = clientState.agent_id
            try {
              const { data: freshSession } = await supabase.from('agent_sessions')
                .select('id')
                .eq('agent_id', agentIdInbound)
                .single()
              if (freshSession) {
                await dialQueue.add('dial-next', {
                  agentId: agentIdInbound,
                  sessionId: freshSession.id,
                  batchSize: 2
                }, { priority: 1, jobId: `immediate-${agentIdInbound}-${Date.now()}` })
                console.log(`[BATCH] Immediately re-queued dial for agent ${agentIdInbound}`)
              }
            } catch (requeueErr) {
              console.error(`[BATCH] Failed to re-queue for agent ${agentIdInbound}:`, requeueErr)
            }
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
    }) // end setImmediate

    return reply.status(200).send({ ok: true })
  }

  const telnyxRateLimitConfig = {
    config: {
      rateLimit: {
        max: 500,
        timeWindow: 10 * 1000,
      },
    },
  } as any

  app.post('/telnyx', telnyxRateLimitConfig, handleTelnyxWebhook)
  app.post('/webhooks/telnyx', telnyxRateLimitConfig, handleTelnyxWebhook)
}
