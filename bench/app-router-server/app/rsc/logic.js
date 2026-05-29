import { foo } from './foo'

export async function logic() {
  'use cache'
  console.log('action running')
  return foo()
}
