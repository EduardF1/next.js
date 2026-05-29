import * as React from 'react'
import { logic } from './logic'

export default function page() {
  const data = logic()
  return <div>hello {data}</div>
}
