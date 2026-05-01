import 'dotenv/config';
import { Worker, Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { supabase } from '../lib/supabase.js';
import { redis } from '../lib/redis.js';
import { dialQueue } from '../lib/dialQueue.js';
import { checkAndPauseCampaignIfNeeded } from '../lib/abandonmentMonitor.js';
import Telnyx from 'telnyx';

const telnyxApiKey = (process.env.TELNYX_API_KEY ?? '').trim();
const telnyx = new (Telnyx as any)({ apiKey: telnyxApiKey });

const DIAL_QUEUE = 'dial-queue';

// ── TCPA: area code → IANA timezone ─────────────────────
const AREA_CODE_TZ: Record<string, string> = {
  // Eastern
  '201':'America/New_York','202':'America/New_York','203':'America/New_York',
  '207':'America/New_York','212':'America/New_York','215':'America/New_York',
  '216':'America/New_York','217':'America/Chicago','218':'America/Chicago',
  '219':'America/Chicago','224':'America/Chicago','225':'America/Chicago',
  '228':'America/Chicago','229':'America/New_York','231':'America/Detroit',
  '234':'America/New_York','239':'America/New_York','240':'America/New_York',
  '248':'America/Detroit','251':'America/Chicago','252':'America/New_York',
  '253':'America/Los_Angeles','256':'America/Chicago','260':'America/Indiana/Indianapolis',
  '267':'America/New_York','269':'America/Detroit','270':'America/Chicago',
  '272':'America/New_York','276':'America/New_York','281':'America/Chicago',
  '301':'America/New_York','302':'America/New_York','303':'America/Denver',
  '304':'America/New_York','305':'America/New_York','307':'America/Denver',
  '308':'America/Chicago','309':'America/Chicago','310':'America/Los_Angeles',
  '312':'America/Chicago','313':'America/Detroit','314':'America/Chicago',
  '315':'America/New_York','316':'America/Chicago','317':'America/Indiana/Indianapolis',
  '318':'America/Chicago','319':'America/Chicago','320':'America/Chicago',
  '321':'America/New_York','323':'America/Los_Angeles','325':'America/Chicago',
  '330':'America/New_York','331':'America/Chicago','334':'America/Chicago',
  '336':'America/New_York','337':'America/Chicago','339':'America/New_York',
  '347':'America/New_York','351':'America/New_York','352':'America/New_York',
  '360':'America/Los_Angeles','361':'America/Chicago','369':'America/Los_Angeles',
  '380':'America/New_York','385':'America/Denver','386':'America/New_York',
  '401':'America/New_York','402':'America/Chicago','404':'America/New_York',
  '405':'America/Chicago','406':'America/Denver','407':'America/New_York',
  '408':'America/Los_Angeles','409':'America/Chicago','410':'America/New_York',
  '412':'America/New_York','413':'America/New_York','414':'America/Chicago',
  '415':'America/Los_Angeles','417':'America/Chicago','419':'America/New_York',
  '423':'America/New_York','424':'America/Los_Angeles','425':'America/Los_Angeles',
  '430':'America/Chicago','432':'America/Chicago','434':'America/New_York',
  '435':'America/Denver','440':'America/New_York','443':'America/New_York',
  '458':'America/Los_Angeles','463':'America/Indiana/Indianapolis','469':'America/Chicago',
  '470':'America/New_York','475':'America/New_York','478':'America/New_York',
  '479':'America/Chicago','480':'America/Phoenix','484':'America/New_York',
  '501':'America/Chicago','502':'America/New_York','503':'America/Los_Angeles',
  '504':'America/Chicago','505':'America/Denver','507':'America/Chicago',
  '508':'America/New_York','509':'America/Los_Angeles','510':'America/Los_Angeles',
  '512':'America/Chicago','513':'America/New_York','515':'America/Chicago',
  '516':'America/New_York','517':'America/Detroit','518':'America/New_York',
  '520':'America/Phoenix','530':'America/Los_Angeles','531':'America/Chicago',
  '534':'America/Chicago','539':'America/Chicago','540':'America/New_York',
  '541':'America/Los_Angeles','551':'America/New_York','559':'America/Los_Angeles',
  '561':'America/New_York','562':'America/Los_Angeles','563':'America/Chicago',
  '567':'America/New_York','570':'America/New_York','571':'America/New_York',
  '573':'America/Chicago','574':'America/Indiana/Indianapolis','575':'America/Denver',
  '580':'America/Chicago','585':'America/New_York','586':'America/Detroit',
  '601':'America/Chicago','602':'America/Phoenix','603':'America/New_York',
  '605':'America/Chicago','606':'America/New_York','607':'America/New_York',
  '608':'America/Chicago','609':'America/New_York','610':'America/New_York',
  '612':'America/Chicago','614':'America/New_York','615':'America/Chicago',
  '616':'America/Detroit','617':'America/New_York','618':'America/Chicago',
  '619':'America/Los_Angeles','620':'America/Chicago','623':'America/Phoenix',
  '626':'America/Los_Angeles','628':'America/Los_Angeles','630':'America/Chicago',
  '631':'America/New_York','636':'America/Chicago','641':'America/Chicago',
  '646':'America/New_York','650':'America/Los_Angeles','651':'America/Chicago',
  '657':'America/Los_Angeles','660':'America/Chicago','661':'America/Los_Angeles',
  '662':'America/Chicago','667':'America/New_York','669':'America/Los_Angeles',
  '678':'America/New_York','681':'America/New_York','682':'America/Chicago',
  '701':'America/Chicago','702':'America/Los_Angeles','703':'America/New_York',
  '704':'America/New_York','706':'America/New_York','707':'America/Los_Angeles',
  '708':'America/Chicago','712':'America/Chicago','713':'America/Chicago',
  '714':'America/Los_Angeles','715':'America/Chicago','716':'America/New_York',
  '717':'America/New_York','718':'America/New_York','719':'America/Denver',
  '720':'America/Denver','724':'America/New_York','725':'America/Los_Angeles',
  '727':'America/New_York','731':'America/Chicago','732':'America/New_York',
  '734':'America/Detroit','737':'America/Chicago','740':'America/New_York',
  '743':'America/New_York','747':'America/Los_Angeles','754':'America/New_York',
  '757':'America/New_York','760':'America/Los_Angeles','762':'America/New_York',
  '763':'America/Chicago','765':'America/Indiana/Indianapolis','769':'America/Chicago',
  '770':'America/New_York','772':'America/New_York','773':'America/Chicago',
  '774':'America/New_York','775':'America/Los_Angeles','779':'America/Chicago',
  '781':'America/New_York','785':'America/Chicago','786':'America/New_York',
  '801':'America/Denver','802':'America/New_York','803':'America/New_York',
  '804':'America/New_York','805':'America/Los_Angeles','806':'America/Chicago',
  '808':'Pacific/Honolulu','810':'America/Detroit','812':'America/Indiana/Indianapolis',
  '813':'America/New_York','814':'America/New_York','815':'America/Chicago',
  '816':'America/Chicago','817':'America/Chicago','818':'America/Los_Angeles',
  '828':'America/New_York','830':'America/Chicago','831':'America/Los_Angeles',
  '832':'America/Chicago','843':'America/New_York','845':'America/New_York',
  '847':'America/Chicago','848':'America/New_York','850':'America/Chicago',
  '856':'America/New_York','857':'America/New_York','858':'America/Los_Angeles',
  '859':'America/New_York','860':'America/New_York','862':'America/New_York',
  '863':'America/New_York','864':'America/New_York','865':'America/New_York',
  '870':'America/Chicago','872':'America/Chicago','878':'America/New_York',
  '901':'America/Chicago','903':'America/Chicago','904':'America/New_York',
  '906':'America/Detroit','907':'America/Anchorage','908':'America/New_York',
  '909':'America/Los_Angeles','910':'America/New_York','912':'America/New_York',
  '913':'America/Chicago','914':'America/New_York','915':'America/Denver',
  '916':'America/Los_Angeles','917':'America/New_York','918':'America/Chicago',
  '919':'America/New_York','920':'America/Chicago','925':'America/Los_Angeles',
  '928':'America/Phoenix','929':'America/New_York','930':'America/Indiana/Indianapolis',
  '931':'America/Chicago','936':'America/Chicago','937':'America/New_York',
  '940':'America/Chicago','941':'America/New_York','947':'America/Detroit',
  '949':'America/Los_Angeles','951':'America/Los_Angeles','952':'America/Chicago',
  '954':'America/New_York','956':'America/Chicago','959':'America/New_York',
  '970':'America/Denver','971':'America/Los_Angeles','972':'America/Chicago',
  '973':'America/New_York','975':'America/Chicago','978':'America/New_York',
  '979':'America/Chicago','980':'America/New_York','984':'America/New_York',
  '985':'America/Chicago','989':'America/Detroit',
};

function getTCPATimezone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const areaCode = digits.startsWith('1') ? digits.slice(1, 4) : digits.slice(0, 3);
  return AREA_CODE_TZ[areaCode] ?? 'America/Chicago'; // default to Central if unknown
}

function isTCPACallable(phone: string, timezone?: string | null): boolean {
  const tz = timezone || getTCPATimezone(phone);
  try {
    const now = new Date();
    const localHour = parseInt(
      now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false })
    );
    return localHour >= 8 && localHour < 21; // 8am–9pm
  } catch {
    return true; // if tz is invalid, allow the call
  }
}
const TICK_INTERVAL_MS = 3000; // Check for READY agents every 3s
const DIALER_MODE = (process.env.DIALER_MODE ?? 'production').toLowerCase();
const TEST_PHONE_NUMBER = process.env.TEST_PHONE_NUMBER ?? '';
const TEST_PHONE_NUMBERS = (process.env.TEST_PHONE_NUMBERS ?? '')
  .split(',')
  .map((phone) => phone.trim())
  .filter(Boolean);
const POST_RELEASE_COOLDOWN_MS = 2000; // delay before agent becomes eligible again
const ORIGINATE_FAILURE_COOLDOWN_MS = 30000;
const SOLO_AGENT_BATCH_SIZE = 3;
const MULTI_AGENT_BATCH_SIZE = 3;
let abandonmentMonitorTick = 0;

function getErrorDetails(err: any) {
  return {
    message: err?.message ?? String(err),
    code: err?.code,
    statusCode: err?.statusCode ?? err?.status,
    raw: err?.raw ?? err?.response?.data ?? err,
  };
}

function isTestPhoneNumber(phone: string): boolean {
  return TEST_PHONE_NUMBERS.includes(phone) || (!!TEST_PHONE_NUMBER && phone === TEST_PHONE_NUMBER);
}

function buildAgentDialTarget(sipUsername: string): string {
  // Each agent has their own Telnyx credential connection (anchorsite: Chicago, IL).
  // Agents register via WebRTC SDK using (username, password) from the credential
  // connection and dial via sip:${username}@sip.telnyx.com (AGENT_LEG_SIP_DOMAIN).
  // Both the credential connection and call control app must use the same anchorsite.
  const fallbackDomain = process.env.AGENT_LEG_SIP_DOMAIN || 'sip.telnyx.com';
  const normalizedUsername = sipUsername.trim().replace(/^sip:/, '').split('@')[0];
  return `sip:${normalizedUsername}@${fallbackDomain}`;
}

// ── Ticker: find READY agents and queue dial jobs ─────────
async function tick() {
  try {
    // Find all READY agents with no active call
    const { data: readySessions } = await supabase
      .from('agent_sessions')
      .select('id, agent_id')
      .eq('state', 'READY')
      .is('active_call_id', null);

    if (!readySessions || readySessions.length === 0) return;

    abandonmentMonitorTick += 1;
    if (abandonmentMonitorTick % 10 === 0) {
      const { data: campaigns, error: campaignError } = await supabase
        .from('campaigns')
        .select('id')
        .eq('status', 'active');

      if (campaignError) {
        console.error('[COMPLIANCE] Failed to fetch campaigns for abandonment check:', campaignError.message);
      }

      for (const campaign of campaigns ?? []) {
        const paused = await checkAndPauseCampaignIfNeeded(supabase, campaign.id);
        if (paused) return;
      }
    }

    const readyCount = readySessions.length;

    // Batch size rules:
    // 1 agent online  → 2:1 (enough coverage, not over-dialing solo)
    // 2+ agents online → 3:1 (full predictive, enough agents to handle pickups)
    const batchSize = readyCount >= 2 ? MULTI_AGENT_BATCH_SIZE : SOLO_AGENT_BATCH_SIZE;

    console.log(`[TICKER] ${readyCount} agent(s) ready — batch size: ${batchSize} | mode=${DIALER_MODE} | test_numbers=${TEST_PHONE_NUMBERS.length}`);

    for (const session of readySessions) {
      const lockKey = `dialer:agent:${session.agent_id}:locked`;
      const locked = await redis.get(lockKey);
      if (locked) {
        console.log(`[TICKER_SKIP_AGENT_NOT_READY] agent_id=${session.agent_id} reason=redis_lock`);
        continue;
      }

      // Lock this agent for 30 seconds
      await redis.set(lockKey, '1', 'EX', 30);

      await dialQueue.add('dial-next', {
        agentId:   session.agent_id,
        sessionId: session.id,
        batchSize,
      });
    }
  } catch (err) {
    console.error('[TICKER] Error:', err);
  }
}

// ── Worker: process dial-next jobs ───────────────────────
const dialWorker = new Worker(
  DIAL_QUEUE,
  async (job: Job) => {
    const { agentId } = job.data;
    const batchSize = Number(job.data.batchSize ?? SOLO_AGENT_BATCH_SIZE);

    console.log(`[WORKER] Processing dial-next for agent: ${agentId}`);

    // 1. Reserve agent atomically. READY is required only at the claim boundary.
    const groupId = randomUUID();
    const { data: reservedSession, error: reserveError } = await supabase
      .from('agent_sessions')
      .update({ state: 'RESERVED', updated_at: new Date().toISOString() })
      .eq('agent_id', agentId)
      .eq('state', 'READY')
      .is('active_call_id', null)
      .select('agent_id, state, active_call_id')
      .maybeSingle();

    if (!reservedSession || reserveError) {
      console.log(`[TICKER_SKIP_AGENT_NOT_READY] agent_id=${agentId} reason=reserve_failed`);
      await releaseLock(agentId);
      return;
    }

    await redis.set(`dialer:agent:${agentId}:locked`, groupId, 'EX', 900);
    console.log(`[BATCH_CLAIM] agent_id=${agentId} group_id=${groupId} batch_size=${batchSize}`);

    // 2. Get agent info
    const { data: agent } = await supabase
      .from('agents')
      .select('id, telnyx_sip_username, telnyx_credential_id')
      .eq('id', agentId)
      .single();

    if (!agent?.telnyx_sip_username) {
      console.error(`[WORKER] Agent ${agentId} has no Telnyx SIP username`);
      await supabase
        .from('agent_sessions')
        .update({ state: 'READY', active_call_id: null, updated_at: new Date().toISOString() })
        .eq('agent_id', agentId);
      await releaseLock(agentId);
      return;
    }

    // 4. Pick next lead from active campaign and enforce attempts cap
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('id, max_attempts')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!campaign?.id) {
      console.log(`[WORKER] No active campaign found — releasing agent ${agentId}`);
      await supabase
        .from('agent_sessions')
        .update({ state: 'READY', updated_at: new Date().toISOString() })
        .eq('agent_id', agentId);
      await releaseLock(agentId);
      return;
    }

    const maxAttempts = Number(campaign.max_attempts ?? 3);

    // ── SKIP LOCKED: Use RPC function for atomic lead fetching with SKIP LOCKED
    // In test mode, filter by test phone numbers
    let filterPhones: string[] | null = null;
    if (DIALER_MODE !== 'production') {
      if (TEST_PHONE_NUMBERS.length > 0) {
        filterPhones = TEST_PHONE_NUMBERS;
      } else if (TEST_PHONE_NUMBER) {
        filterPhones = [TEST_PHONE_NUMBER];
      } else {
        console.warn(`[WORKER] DIALER_MODE=${DIALER_MODE} but no test phone numbers are set — skipping`);
        await supabase
          .from('agent_sessions')
          .update({ state: 'READY', updated_at: new Date().toISOString() })
          .eq('agent_id', agentId);
        await releaseLock(agentId);
        return;
      }
    }

    let leads: any[] = [];

    if (filterPhones) {
      // In test mode, fetch ONLY the controlled test leads directly.
      // Do not rely on the production RPC candidate window, because it may return
      // random real leads before the test leads and make filtering look empty.
      const { data: testCandidates, error: testFetchError } = await supabase
        .from('leads')
        .select('id, campaign_id, phone, first_name, last_name, status, attempts, assigned_agent_id')
        .eq('campaign_id', campaign.id)
        .in('phone', filterPhones)
        .in('status', ['pending', 'failed', 'no_answer', 'voicemail'])
        .lt('attempts', maxAttempts)
        .is('assigned_agent_id', null)
        .order('last_name', { ascending: true })
        .limit(batchSize);

      if (testFetchError) {
        console.error(`[WORKER] Test lead fetch error: ${testFetchError.message}`);
        await supabase
          .from('agent_sessions')
          .update({ state: 'READY', updated_at: new Date().toISOString() })
          .eq('agent_id', agentId);
        await releaseLock(agentId);
        return;
      }

      leads = (testCandidates ?? []) as any[];
      console.log(`[WORKER] TEST MODE candidates: ${leads.map((l) => `${l.first_name ?? ''} ${l.last_name ?? ''} ${l.phone}`).join(' | ') || 'none'}`);
    } else {
      // Production path: Fetch candidates with SKIP LOCKED.
      const { data: allCandidates, error: fetchError } = await supabase.rpc('fetch_leads_skip_locked', {
        p_campaign_id: campaign.id,
        p_max_attempts: maxAttempts,
        p_batch_size: 25,
      });

      if (fetchError) {
        console.error(`[WORKER] Lead fetch error: ${fetchError.message}`);
        await supabase
          .from('agent_sessions')
          .update({ state: 'READY', updated_at: new Date().toISOString() })
          .eq('agent_id', agentId);
        await releaseLock(agentId);
        return;
      }

      leads = ((allCandidates ?? []) as any[])
        .filter((lead) => {
          if (!isTCPACallable(lead.phone, (lead as any).timezone)) return false;
          return true;
        })
        .slice(0, batchSize);
    }

    if (leads.length < batchSize) {
      console.log(`[WORKER] No leads available — releasing agent ${agentId}`);
      await supabase
        .from('agent_sessions')
        .update({ state: 'READY', updated_at: new Date().toISOString() })
        .eq('agent_id', agentId);
      await releaseLock(agentId);
      return;
    }

    const leadIds = leads.map((lead) => lead.id);

    // 5. Reserve lead and count this as an attempted dial selection.
    const attemptedAt = new Date().toISOString();
    await supabase
      .from('leads')
      .update({
        status: 'reserved',
        assigned_agent_id: agentId,
        last_called_at: attemptedAt,
      })
      .in('id', leadIds);

    for (const leadId of leadIds) {
      await supabase.rpc('increment', { row_id: leadId, col: 'attempts' });
    }

    // 6. Create call record
    const { data: callRecords, error: callInsertError } = await supabase
      .from('calls')
      .insert(leads.map((lead) => ({
        agent_id: agentId,
        lead_id: lead.id,
        campaign_id: lead.campaign_id,
        group_id: groupId,
        status: 'created',
        started_at: new Date().toISOString(),
      })))
      .select('id, lead_id');

    if (!callRecords || callRecords.length !== leads.length) {
      console.error(`[WORKER] Failed to create call records | error: ${callInsertError?.message ?? 'unknown'} | got ${callRecords?.length ?? 0}/${leads.length}`);
      await rollback(agentId, leadIds);
      return;
    }

    const callIds = callRecords.map((call) => call.id);
    const primaryCallId = callRecords[0].id;
    const agentDialTarget = buildAgentDialTarget(agent.telnyx_sip_username);

    try {
      // 7. Dial ONLY the agent leg. The lead leg is dialed by the webhook handler
      //    when this agent leg is answered. This avoids ringing the lead before
      //    the agent is actually on the line.
      const agentDialRequest = {
        connection_id: process.env.TELNYX_CONNECTION_ID,
        to: agentDialTarget,
        from: process.env.TELNYX_OUTBOUND_NUMBER,
        webhook_url: process.env.TELNYX_WEBHOOK_URL,
        client_state: Buffer.from(JSON.stringify({
          leg_type: 'agent',
          call_id: primaryCallId,
          agent_id: agentId,
          lead_ids: leadIds,
        })).toString('base64'),
      };

      console.log(`[AGENT_LEG_DIAL] agent_id=${agentId} destination=${agentDialTarget} group_id=${groupId} batch_size=${batchSize}`);
      console.log('[TELNYX_ORIGINATE_AGENT_REQUEST]', {
        agent_id: agentId,
        group_id: groupId,
        destination: agentDialTarget,
        call_id: primaryCallId,
        lead_ids: leadIds,
        has_connection_id: !!process.env.TELNYX_CONNECTION_ID,
        from: process.env.TELNYX_OUTBOUND_NUMBER,
      });

      const agentCallResponse = await telnyx.calls.dial(agentDialRequest);

      const agentCallControlId = agentCallResponse.data.call_control_id;

      console.log('[TELNYX_ORIGINATE_AGENT_RESPONSE]', {
        agent_id: agentId,
        group_id: groupId,
        call_id: primaryCallId,
        agent_call_control_id: agentCallControlId,
        response: agentCallResponse.data,
      });

      // 8. Update call with agent leg, status=agent_dialing
      await supabase
        .from('calls')
        .update({
          call_control_id: agentCallControlId,
          agent_leg_id: agentCallControlId,
          status: 'agent_dialing',
        })
        .in('id', callIds);

      console.log(`[WORKER] Dialing agent ${agentDialTarget} | leads held: ${leadIds.join(',')} | batch size: ${batchSize} | group: ${groupId}`);
    } catch (err: any) {
      const errorDetails = getErrorDetails(err);
      console.error('[TELNYX_ORIGINATE_AGENT_ERROR]', {
        agent_id: agentId,
        group_id: groupId,
        call_ids: callIds,
        error: errorDetails,
      });
      console.error(`[WORKER] Agent dial failed: ${errorDetails.message}`);
      await failReservedLeads(agentId, leadIds);
      await supabase
        .from('calls')
        .update({
          status: 'failed',
          notes: JSON.stringify({ telnyx_agent_originate_error: errorDetails }),
          ended_at: new Date().toISOString(),
        })
        .in('id', callIds);
    }
  },
  {
    connection: redis,
    concurrency: 10, // process 10 agents simultaneously
  }
);

// ── Helpers ───────────────────────────────────────────────
async function releaseLock(agentId: string) {
  await redis.del(`dialer:agent:${agentId}:locked`);
}

// Cooldown lock prevents the ticker from immediately re-queuing an agent
// right after a no-answer/voicemail release. Webhook handler sets this.
export async function setAgentCooldown(agentId: string, ms = POST_RELEASE_COOLDOWN_MS) {
  await redis.set(`dialer:agent:${agentId}:locked`, '1', 'PX', ms);
}

async function rollback(agentId: string, leadIds: string[]) {
  await supabase
    .from('agent_sessions')
    .update({ state: 'READY', updated_at: new Date().toISOString() })
    .eq('agent_id', agentId);

  await supabase
    .from('leads')
    .update({ status: 'pending', assigned_agent_id: null })
    .in('id', leadIds);

  await releaseLock(agentId);
}

async function failReservedLeads(agentId: string, leadIds: string[]) {
  await supabase
    .from('agent_sessions')
    .update({ state: 'READY', active_call_id: null, updated_at: new Date().toISOString() })
    .eq('agent_id', agentId);

  await supabase
    .from('leads')
    .update({ status: 'failed', assigned_agent_id: null })
    .in('id', leadIds);

  console.log(`[BATCH_FAILED_RELEASE_AGENT] agent_id=${agentId} lead_ids=${leadIds.join(',')}`);

  await redis.set(`dialer:agent:${agentId}:locked`, '1', 'PX', ORIGINATE_FAILURE_COOLDOWN_MS);
}

// ── Worker error handling ─────────────────────────────────
dialWorker.on('failed', (job, err) => {
  console.error(`[WORKER] Job failed: ${job?.id}`, err);
});

dialWorker.on('completed', (job) => {
  console.log(`[WORKER] Job completed: ${job.id}`);
});

// ── Start ticker ──────────────────────────────────────────
console.log('[DIALER] Worker started — ticking every 3s');
setInterval(tick, TICK_INTERVAL_MS);
tick(); // immediate first tick
