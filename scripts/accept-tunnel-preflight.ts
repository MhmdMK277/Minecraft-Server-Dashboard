/**
 * ACCEPTANCE (preflight half): everything about public access that can be
 * verified against the real world WITHOUT executing the downloaded binary
 * and WITHOUT touching an operator's playit account.
 *
 *   1. The real release download: fetch the release listing from GitHub,
 *      download the signed agent, verify it against the digest the release
 *      declares, then read its Authenticode signature. The binary is never
 *      run; Get-AuthenticodeSignature reads bytes.
 *   2. The real claim endpoint: generate a code the way the agent does and
 *      POST it to /claim/setup. The API must answer inside its documented
 *      envelope with WaitingForUserVisit, which proves the endpoint, the
 *      envelope and our request shape against the live service. The claim
 *      then simply expires unapproved; nothing is created anywhere.
 *
 * What this deliberately does NOT do, stated because the gap is the point:
 * approving a claim (that is the operator's browser and account) and running
 * the agent (the operator asked to be asked first). Those two form the
 * second half of the acceptance and happen with the operator present.
 *
 * WORLD: throwaway MCDASH_DATA_DIR; real network to api.github.com,
 * github.com asset hosts, and api.playit.gg.
 *
 * Run:  npx tsx scripts/accept-tunnel-preflight.ts
 */
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA = mkdtempSync(join(tmpdir(), 'mcdash-tunnel-accept-'))
process.env.MCDASH_DATA_DIR = DATA

const { installAgent, startClaim, pollClaim, agentExePath } = await import('../server/tunnel')
const { initAudit } = await import('../server/audit')
initAudit(DATA)

const checks: Array<[string, boolean, string?]> = []
const check = (l: string, ok: boolean, d?: string) => checks.push([l, ok, d])
const IDENT = { actor: 'acceptance', role: 'admin', ip: '127.0.0.1' }

console.log('\n=== 1. the real download, verified twice ===\n')
const installed = await installAgent(IDENT)
check('the live release installs against its declared digest', installed.ok, installed.ok ? undefined : installed.reason)
if (installed.ok) {
  console.log(`version   : ${installed.version}`)
  console.log(`exe       : ${agentExePath(DATA)} (${(statSync(agentExePath(DATA)).size / 1024 / 1024).toFixed(1)} MB)`)
  check('the exe landed', existsSync(agentExePath(DATA)))
}

console.log('\n=== 2. the real claim endpoint, up to the operator boundary ===\n')
const started = startClaim(IDENT)
console.log(`claim url : ${started.url}`)
const polled = await pollClaim(IDENT)
console.log(`state     : ${polled.state} (${polled.detail})`)
check(
  'playit answers the setup poll inside its envelope with waiting-visit',
  polled.state === 'waiting-visit',
  polled.state,
)
check('the URL is the playit claim form for our locally generated code', /^https:\/\/playit\.gg\/claim\/[0-9a-f]{10}$/.test(started.url ?? ''))

let pass = 0
let fail = 0
for (const [label, ok, detail] of checks) {
  if (ok) pass++
  else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`)
  }
}
console.log('\n================================================================')
if (fail === 0) console.log(`ALL PASS. ${pass} checks`)
else console.log(`${fail} FAILED, ${pass} passed`)
console.log(`world: ${DATA} (left in place; the unapproved claim simply expires)`)
process.exit(fail === 0 ? 0 : 1)
