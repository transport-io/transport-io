import { createHooks } from '@transport-io/react'
import type { ChatMap } from '../contract.ts'

export const api = createHooks<ChatMap>()
