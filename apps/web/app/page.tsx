// Landing page: what the product does, the AI apps it works with, the nine platforms, pricing
// (from @app/core/plans), FAQ and the call to action. Static.

import { LandingPage } from '@/components/marketing/landing'

export default function HomePage() {
  return <LandingPage year={new Date().getUTCFullYear()} />
}
