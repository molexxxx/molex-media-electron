/**
 * Compile-time checks of the jobs contract; this file has no runtime code. Both typechecks fail when a command loses
 * its channel, its request, or its result, when JobsApi stops having exactly one method per command plus onEvents, or
 * when a method's request or result drifts from the command map.
 */
import type
{
  CommandResult,
  JOB_CHANNELS,
  JOB_EVENT_CHANNEL,
  JOB_EVENT_TYPES,
  JobCommandMap,
  JobCommandName,
  JobEventBatch,
  JobEventType,
  JobsApi
} from './contract'
import type
{
  BatchPolicy,
  BatchSummary,
  EngineSnapshot,
  JobError,
  JobView,
  JobWarningCode,
  PlanSummary,
  PresetState,
  RecentFolder,
  ResultStamp,
  RunAlert,
  RunAlertKind,
  RunSettings,
  ScanState
} from './types'

/** True exactly when two types are identical. */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

/** Accepts only true. */
export type Expect<T extends true> = T

type Known<T> = unknown extends T ? false : [T] extends [never] ? false : true

type HasRequestAndResult<K extends JobCommandName> =
  JobCommandMap[K] extends { req: infer Req; res: infer Res }
    ? Equal<keyof JobCommandMap[K], 'req' | 'res'> extends true
      ? Known<Req> extends true ? Known<Res> : false
      : false
    : false

type EveryCommand<Check extends Record<JobCommandName, boolean>> = Check[JobCommandName]

/** The channel map and the command map name the same commands. */
export type ChannelsMatchCommands = Expect<Equal<keyof typeof JOB_CHANNELS, JobCommandName>>

/** Every command has a request type and a result type, and nothing else. */
export type CommandsHaveRequestAndResult = Expect<Equal<EveryCommand<{ [K in JobCommandName]: HasRequestAndResult<K> }>, true>>

/** JobsApi has one method per command plus onEvents, and nothing more. */
export type ApiHasOneMethodPerCommand = Expect<Equal<keyof JobsApi, JobCommandName | 'onEvents'>>

/** Each method takes its command's request and resolves to its command's result envelope. */
export type ApiMethodsMatchCommands = Expect<Equal<
  EveryCommand<{ [K in JobCommandName]: Equal<JobsApi[K], (req: JobCommandMap[K]['req']) => Promise<CommandResult<JobCommandMap[K]['res']>>> }>,
  true
>>

/** onEvents takes a batch listener and returns an unsubscribe. */
export type OnEventsReturnsUnsubscribe = Expect<Equal<JobsApi['onEvents'], (cb: (batch: JobEventBatch) => void) => () => void>>

/** Every channel is a jobs:, run:, runs:, or presets: channel. */
export type ChannelsArePrefixed = Expect<
  (typeof JOB_CHANNELS)[JobCommandName] extends `${'jobs' | 'run' | 'runs' | 'presets'}:${string}` ? true : false
>

/** Events travel on jobs:event. */
export type EventChannelIsJobsEvent = Expect<Equal<typeof JOB_EVENT_CHANNEL, 'jobs:event'>>

/** The event type list names every event type exactly. */
export type EventTypesAreComplete = Expect<Equal<(typeof JOB_EVENT_TYPES)[number], JobEventType>>

type HasKeys<T, K extends PropertyKey> = K extends keyof T ? true : false

type AllTrue<T extends boolean> = Equal<T, true>

/** The live plan on every row: the output path relative to its folder, the encoder label, and the first issue. */
export type PlanSummaryCarriesReviewColumns = Expect<AllTrue<HasKeys<PlanSummary, 'relativePath' | 'encoderLabel' | 'firstIssue'>>>

/** Rows carry the Audio plan column, whether Review measured them, and their warnings. */
export type JobViewCarriesPlanAndWarnings = Expect<AllTrue<HasKeys<JobView, 'audioPlan' | 'previewed' | 'warnings'>>>

/** The eight warnings a done job keeps lit until acknowledged. */
export type WarningCodesAreTheEight = Expect<Equal<JobWarningCode,
  | 'original-kept' | 'previous-kept' | 'ran-on-cpu' | 'source-changed'
  | 'below-target-unpreviewed' | 'outside-tolerance-placed' | 'larger-than-source' | 'decoded-overshoot'>>

/** Alerts for restored queues, an unavailable destination, and migrated Replace defaults, with what their banners need. */
export type RunAlertCarriesBannerData = Expect<AllTrue<
  | ('restored-queue' | 'destination-unavailable' | 'replace-migrated' extends RunAlertKind ? true : false)
  | Equal<RunAlert['kind'], RunAlertKind>
  | HasKeys<RunAlert, 'path' | 'jobIds' | 'counts' | 'dismissible'>
>>

/** Batch summaries carry returned and reachable counts, media time, previous files, recipes, albums, and the build. */
export type BatchSummaryCarriesOutcomes = Expect<AllTrue<
  | HasKeys<BatchSummary['counts'], 'returned' | 'reachable'>
  | HasKeys<BatchSummary, 'mediaSec' | 'previous' | 'recipes' | 'albums' | 'ffmpeg' | 'appVersion'>
>>

/** Stamps carry what a row prints: container, decode depth, stream counts, the loudness reference and check, both peaks. */
export type ResultStampCarriesEveryValue = Expect<AllTrue<
  | HasKeys<ResultStamp, 'container' | 'decode' | 'audioStreams' | 'verdictStream' | 'size' | 'frames' | 'cues'>
  | HasKeys<NonNullable<ResultStamp['loudness']>, 'reference' | 'check' | 'checkClass' | 'deviationUnit'>
  | HasKeys<NonNullable<ResultStamp['truePeak']>, 'dbtp' | 'preEncodeDbtp'>
>>

/** Errors carry their short reason and their cause. */
export type JobErrorCarriesShortAndCause = Expect<AllTrue<HasKeys<JobError, 'short' | 'cause'>>>

/** A scan can report that it failed. */
export type ScanCanFail = Expect<'failed' extends ScanState['status'] ? true : false>

/** Recent folders and preset state reach the page in the snapshot. */
export type SnapshotCarriesFoldersAndPresets = Expect<AllTrue<
  | Equal<EngineSnapshot['recentFolders'], RecentFolder[]>
  | Equal<EngineSnapshot['presets'], PresetState>
>>

/** The policy says what happens to displaced files. */
export type PolicyHasDisplaced = Expect<Equal<BatchPolicy['displaced'], 'trash' | 'keep'>>

/** Run settings keep the Review measuring preference and the Add menu's subfolder choice. */
export type RunSettingsCarryPagePreferences = Expect<AllTrue<
  | Equal<RunSettings['measureOnReview'], boolean>
  | Equal<RunSettings['includeSubfolders'], boolean>
>>
