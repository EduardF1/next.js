import { foo } from './foo'
import { external } from 'external-dep'

export async function logic() {
  'use cache'
  return `${foo()}:${external()}`
}
