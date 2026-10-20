/**
 * Type-level checks for the icon registry, compiled by the renderer typecheck and never imported at runtime.
 * Every alias below must compile; the marked one must not, so the build fails if an unknown key ever does.
 */
import type { ButtonProps } from './Button'
import type { IconProps } from './Icon'
import type { IconName } from './icons'

type Accepts<T extends IconName> = T

/** The batch page's keys, which must stay in the registry. */
export type BatchIconKeys = Accepts<
  | 'action.pin'
  | 'action.paste'
  | 'action.locate'
  | 'action.relink'
  | 'action.takeOut'
  | 'action.selectSimilar'
  | 'action.shortcuts'
  | 'nav.history'
>

/** Icon and Button take registry keys, not components or free strings. */
export type IconNameProps = Accepts<IconProps['name'] | NonNullable<ButtonProps['icon']> | NonNullable<ButtonProps['iconEnd']>>

// @ts-expect-error an unknown key is not an icon name
export type UnknownIconKey = Accepts<'action.unknown'>

// @ts-expect-error a deprecated lucide alias is not an icon name either
export type AliasIconKey = Accepts<'History'>
