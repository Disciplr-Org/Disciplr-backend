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

async function main() {
  console.log('Generating OpenAPI specification...')
  const spec = generateOpenApiSpec()
  const cleanSpec = stripFunctions(spec) as object
  const yamlSpec = stringify(cleanSpec)
  const outputDir = path.resolve(__dirname, '../../docs')
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, 'openapi.yaml')
  fs.writeFileSync(outputPath, yamlSpec, 'utf8')
  console.log(`OpenAPI specification generated at: ${outputPath}`)
}

main().catch((err) => {
  console.error('Failed to generate OpenAPI spec:', err)
  process.exit(1)
})
