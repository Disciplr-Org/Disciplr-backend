import { generateOpenApiSpec } from './openapi-generator.js'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { stringify } from 'yaml'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function stripFunctions(obj: unknown): unknown {
  if (typeof obj === 'function') return undefined
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(stripFunctions)
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const cleaned = stripFunctions(v)
    if (cleaned !== undefined) result[k] = cleaned
  }
  return result
}

/**
 * Produce a human-readable unified diff between two strings.
 * Returns an empty string when they are identical.
 */
function simpleDiff(committed: string, generated: string): string {
  if (committed === generated) return ''

  const committedLines = committed.split('\n')
  const generatedLines = generated.split('\n')
  const lines: string[] = []

  const maxLen = Math.max(committedLines.length, generatedLines.length)
  let diffCount = 0
  for (let i = 0; i < maxLen; i++) {
    const a = committedLines[i]
    const b = generatedLines[i]
    if (a !== b) {
      if (a !== undefined) lines.push(`- ${a}`)
      if (b !== undefined) lines.push(`+ ${b}`)
      diffCount++
      if (diffCount >= 40) {
        lines.push(`... (truncated — ${maxLen - i} more lines differ)`)
        break
      }
    }
  }
  return lines.join('\n')
}

async function main() {
  const checkMode = process.argv.includes('--check')

  console.log(
    checkMode
      ? 'Checking OpenAPI specification for drift...'
      : 'Generating OpenAPI specification...',
  )

  const spec = generateOpenApiSpec()
  const cleanSpec = stripFunctions(spec) as object
  const generatedYaml = stringify(cleanSpec)

  const outputDir = path.resolve(__dirname, '../../docs')
  const outputPath = path.join(outputDir, 'openapi.yaml')

  if (checkMode) {
    // In check mode: compare generated output against the committed file and
    // fail with a non-zero exit code when they differ.
    if (!fs.existsSync(outputPath)) {
      console.error(
        `ERROR: ${outputPath} does not exist.\nRun 'npm run openapi:generate' to create it.`,
      )
      process.exit(1)
    }

    const committed = fs.readFileSync(outputPath, 'utf8')
    if (committed === generatedYaml) {
      console.log('✓ docs/openapi.yaml is up-to-date.')
      process.exit(0)
    }

    const diff = simpleDiff(committed, generatedYaml)
    console.error(
      `ERROR: docs/openapi.yaml is out of sync with the current routes.\n` +
        `Run 'npm run openapi:generate' to regenerate it and commit the result.\n\n` +
        `Diff (committed → generated):\n${diff}`,
    )
    process.exit(1)
  }

  // Write mode (default)
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(outputPath, generatedYaml, 'utf8')
  console.log(`OpenAPI specification generated at: ${outputPath}`)
}

main().catch((err) => {
  console.error('Failed to generate OpenAPI spec:', err)
  process.exit(1)
})
