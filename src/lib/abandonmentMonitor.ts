export async function getAbandonmentRate(supabase: any, campaignId: string): Promise<number> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data: answered } = await supabase
    .from('calls')
    .select('id, status, answered_at, bridged_at')
    .eq('campaign_id', campaignId)
    .not('answered_at', 'is', null)
    .gte('started_at', thirtyDaysAgo)

  if (!answered?.length) return 0

  const abandoned = answered.filter((c: any) =>
    c.answered_at &&
    !c.bridged_at &&
    c.status !== 'voicemail' &&
    c.status !== 'completed'
  )

  return (abandoned.length / answered.length) * 100
}

export async function checkAndPauseCampaignIfNeeded(supabase: any, campaignId: string) {
  const dialerMode = (process.env.DIALER_MODE || 'live').toLowerCase()
  if (dialerMode === 'test') {
    console.log('[COMPLIANCE] Test mode active — skipping abandonment auto-pause')
    return false
  }

  const rate = await getAbandonmentRate(supabase, campaignId)
  console.log(`[COMPLIANCE] Abandonment rate: ${rate.toFixed(2)}% for campaign ${campaignId}`)

  if (rate >= 3) {
    console.error(`[COMPLIANCE] Abandonment rate ${rate.toFixed(2)}% exceeds 3% - pausing campaign`)
    await supabase
      .from('campaigns')
      .update({ status: 'paused', paused_reason: 'abandonment_rate_exceeded' })
      .eq('id', campaignId)
    return true
  }
  return false
}
