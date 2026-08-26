import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML from 'js-yaml'

const root = resolve(__dirname, '../..')
const workflowPath = resolve(root, '.github/workflows/db-backup.yml')
const runbookPath = resolve(root, 'docs/backup-restore.md')

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('nightly pg_dump workflow', () => {
  it('exists and is valid YAML', () => {
    const raw = read(workflowPath)
    expect(raw.length).toBeGreaterThan(0)
    expect(() => YAML.load(raw)).not.toThrow()
  })

  it('runs on a nightly schedule and workflow_dispatch only', () => {
    const raw = read(workflowPath)
    const doc = YAML.load(raw) as {
      on?: {
        schedule?: { cron: string }[]
        workflow_dispatch?: unknown
        pull_request?: unknown
        push?: unknown
      }
    }
    const crons = (doc.on?.schedule ?? []).map((s) => s.cron)
    expect(crons).toContain('0 3 * * *')
    expect(doc.on?.workflow_dispatch).toBeDefined()
    expect(doc.on?.pull_request).toBeUndefined()
    expect(doc.on?.push).toBeUndefined()
  })

  it('covers both networks via secrets and keeps artifacts 14 days', () => {
    const raw = read(workflowPath)
    expect(raw).toMatch(/secrets\.DATABASE_URL_MAINNET/)
    expect(raw).toMatch(/secrets\.DATABASE_URL_TESTNET/)
    expect(raw).toMatch(/mainnet/)
    expect(raw).toMatch(/testnet/)
    expect(raw).toMatch(/retention-days:\s*14/)
    expect(raw).not.toMatch(/postgres:\/\/[^\s]+:[^\s]+@/)
  })

  it('dumps custom format, gzips, and does not echo the URL', () => {
    const raw = read(workflowPath)
    expect(raw).toMatch(/pg_dump/)
    expect(raw).toMatch(/--format=custom/)
    expect(raw).toMatch(/\bgzip\b/)
    expect(raw).toMatch(/--no-owner/)
    expect(raw).toMatch(/--no-acl/)
    expect(raw).not.toMatch(/echo\s+"?\$\{?DATABASE_URL/)
    expect(raw).not.toMatch(/set\s+-x/)
  })
})

describe('backup restore runbook', () => {
  it('documents pg_restore into a fresh instance and URL swap for both networks', () => {
    const raw = read(runbookPath)
    expect(raw).toMatch(/pg_restore/)
    expect(raw).toMatch(/Neon/i)
    expect(raw).toMatch(/DATABASE_URL/)
    expect(raw).toMatch(/DIRECT_DATABASE_URL/)
    expect(raw).toMatch(/mainnet/i)
    expect(raw).toMatch(/testnet/i)
    expect(raw).toMatch(/pooler|direct/i)
    expect(raw).toMatch(/fresh/i)
  })
})
