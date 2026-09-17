'use client'
/**
 * The React mount. It renders nothing: the panel is plain DOM under `document.body`, mounted
 * in an effect and unmounted by its cleanup, so React never renders a row and a busy session
 * re-renders no component.
 *
 * An explicit component, in the tree because somebody put it there. Nothing in transport-io
 * or its React package imports this, and nothing loads it by environment: a realtime library
 * that attaches something on its own in development is how a heisenbug gets made.
 */
import { type ReactNode, useEffect } from 'react'
import { mountPanel, type PanelOptions } from './panel.ts'
import type { ObservableClient } from './store.ts'

export interface TransportDevtoolsProps extends Omit<PanelOptions, 'schedule'> {
  readonly client: ObservableClient
}

function Devtools({
  client,
  target,
  open,
  preview,
  capacity,
  visibleRows,
}: TransportDevtoolsProps): ReactNode {
  useEffect(
    () =>
      mountPanel(client, {
        ...(target === undefined ? {} : { target }),
        ...(open === undefined ? {} : { open }),
        ...(preview === undefined ? {} : { preview }),
        ...(capacity === undefined ? {} : { capacity }),
        ...(visibleRows === undefined ? {} : { visibleRows }),
      }),
    [client, target, open, preview, capacity, visibleRows],
  )
  return null
}

declare const process: { readonly env: { readonly NODE_ENV?: string } }

/**
 * Renders `null` unless the build says `development`, so an environment nobody configured
 * gets no panel. The expression is written bare, the way `react` itself writes it, because
 * that is the form every bundler replaces with a constant; the constant is what lets a
 * production build drop the panel's code altogether.
 */
export const TransportDevtools: (props: TransportDevtoolsProps) => ReactNode =
  process.env.NODE_ENV === 'development' ? Devtools : () => null
