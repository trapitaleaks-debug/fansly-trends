// One vocabulary for why a job failed, shared by the post stage and the render stage.
//
// Post failures were already classified (classifyPostFailure in post-video-job.ts). Render failures
// were not: process-job.ts and the server watchdog wrote status:'error' with only an error_message,
// so every render failure landed as failure_kind NULL and the only possible response was a blind
// retry of everything. Of the 49 unclassified errors on 26.07.2026, three quarters were one of two
// causes that want completely different handling — a missing R2 object (retrying can never work
// until the asset is restored) and an ffmpeg/Remotion crash (retrying usually does work).

export type FailureKind =
  // post stage
  | 'capacity_full' | 'session_expired' | 'media_upload_timeout' | 'subscription_past_due'
  | 'model_not_found' | 'verify_timeout' | 'tags_empty'
  // render stage
  | 'render_hung' | 'asset_missing' | 'transcode_failed' | 'quarantined'
  | 'unknown'

// Retrying is pointless until a human or another job fixes the underlying thing.
export const NON_RETRYABLE: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'asset_missing', 'quarantined', 'subscription_past_due', 'model_not_found',
])

// Classify a render-stage failure from its error_message. Order matters: the ffmpeg branch is last
// because ffmpeg stderr is hundreds of lines of encoder banner that would otherwise swallow the
// specific causes above it.
export function classifyRenderFailure(msg: string | null | undefined): FailureKind {
  const m = String(msg ?? '')
  if (!m.trim()) return 'unknown'
  if (/\[quarantined:/i.test(m)) return 'quarantined'
  // R2 returns this when the source clip or template asset is gone from the bucket.
  if (/specified key does not exist|NoSuchKey|AccessDenied/i.test(m)) return 'asset_missing'
  if (/wall-clock timeout|render hung|ETIMEDOUT|timed out after/i.test(m)) return 'render_hung'
  if (/ffmpeg|Remotion|libx264|Lavf|Output #0|Stream #0|frame=\s*\d/i.test(m)) return 'transcode_failed'
  return 'unknown'
}
