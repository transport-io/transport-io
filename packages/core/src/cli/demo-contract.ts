/**
 * The contract `transport-io dev --demo` runs.
 *
 * Deliberately not a `*.node.ts` file and importing nothing from Node: the dev server serves
 * the built package as ESM, so the browser half of the demo imports this exact module. Both
 * peers therefore share one contract by construction rather than by two copies agreeing, and
 * a contract mismatch becomes impossible rather than merely unlikely.
 *
 * The explicit type annotation is `isolatedDeclarations`, which is on for this package and is
 * incompatible with the inferred contract pattern for anything exported. Writing the two
 * `ReturnType` lines is cheaper than the alternatives, and nobody outside the demo reads this
 * type, so the hover cost the pattern normally avoids does not apply here.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { defineContract, type MapOf, reliable, unreliable } from '../contract.ts'

export interface DemoChat {
  readonly from: string
  readonly body: string
  readonly at: number
}
export interface DemoCursor {
  readonly from: string
  readonly x: number
  readonly y: number
}

export const demoContract: {
  readonly chat: {
    readonly lane: 'reliable'
    readonly payload: StandardSchemaV1<unknown, DemoChat>
  }
  readonly cursor: {
    readonly lane: 'unreliable'
    readonly payload: StandardSchemaV1<unknown, DemoCursor>
  }
} = defineContract({
  chat: reliable<DemoChat>(),
  cursor: unreliable<DemoCursor>(),
})

export interface DemoMap extends MapOf<typeof demoContract> {}
