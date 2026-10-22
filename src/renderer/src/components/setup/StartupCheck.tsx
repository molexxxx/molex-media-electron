/**
 * @module components/setup/StartupCheck
 * @description The screen shown while startup looks for FFmpeg, laid out where setup starts so nothing jumps when
 * setup follows it.
 */
import type { ReactElement } from 'react'
import { ProgressBar } from '../../ui/ProgressBar'
import { SETUP_WORDS } from './setupFlow'

/** Startup's FFmpeg check: one quiet line and a working bar. */
export function StartupCheck(): ReactElement
{
  return (
    <div className='flex min-h-0 flex-1 flex-col bg-ground' aria-busy='true'>
      <div className='mx-auto flex w-full max-w-2xl flex-col gap-3 px-6 pt-[min(12vh,7rem)]'>
        <p className='text-section font-normal text-ink-2'>{`${SETUP_WORDS.checkingStart}.`}</p>
        <ProgressBar tone='meter' size='sm' label={SETUP_WORDS.checkingStart} showValue={false} className='max-w-xs' />
      </div>
    </div>
  )
}
