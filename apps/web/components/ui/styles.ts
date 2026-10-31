// Shared Tailwind class strings (one look for every button, input and card). Browser-safe.

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600'

const buttonBase = `inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focus}`

export const button = {
  primary: `${buttonBase} bg-indigo-600 text-white hover:bg-indigo-500`,
  secondary: `${buttonBase} border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800`,
  danger: `${buttonBase} border border-red-300 bg-white text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-neutral-900 dark:text-red-300 dark:hover:bg-red-950`,
  ghost: `${buttonBase} text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800`,
  small: 'px-2.5 py-1.5 text-xs',
} as const

export const input = `block w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 ${focus} dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100`

export const label = 'block text-sm font-medium text-neutral-800 dark:text-neutral-200'

export const hint = 'mt-1 text-xs text-neutral-500 dark:text-neutral-400'

export const card = 'rounded-xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900'

export const link = `font-medium text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300 ${focus}`

export const muted = 'text-neutral-600 dark:text-neutral-400'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
