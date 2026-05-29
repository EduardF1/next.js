import { foo } from './foo'

export async function logic() {
  'use cache'
  return foo()
}
