import Telnyx from 'telnyx';

if (!process.env.TELNYX_API_KEY) throw new Error('TELNYX_API_KEY is required');

const telnyx = new (Telnyx as any)({ apiKey: process.env.TELNYX_API_KEY });

// Telnyx v6 SDK: bridge lives under calls.actions
// The call_control_id in the URL is the LEAD leg; body contains AGENT leg.
export async function bridgeLegs(leadCallControlId: string, agentCallControlId: string) {
  const response = await telnyx.calls.actions.bridge(leadCallControlId, {
    call_control_id: agentCallControlId,
  });
  return response.data;
}

export async function hangupCall(callControlId: string) {
  try {
    await telnyx.calls.actions.hangup(callControlId, {});
  } catch (err: any) {
    if (!err?.message?.includes('not found') && !err?.message?.includes('404')) {
      throw err;
    }
  }
}

export async function dialLead(leadPhone: string, agentSipAddress: string, webhookUrl: string, callerId: string) {
  const response = await telnyx.calls.dial({
    connection_id: process.env.TELNYX_CONNECTION_ID,
    to: leadPhone,
    from: callerId,
    webhook_url: webhookUrl,
  });
  return response.data;
}

export function decodeClientState(encoded: string): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

export default telnyx;
