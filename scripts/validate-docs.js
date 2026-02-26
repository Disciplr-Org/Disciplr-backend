import { swaggerSpec } from '../src/config/swagger.js'
import SwaggerParser from '@apidevtools/swagger-parser'

async function validateDocs() {
  try {
    await SwaggerParser.validate(swaggerSpec)
    console.log('✅ OpenAPI spec is valid')
  } catch (err) {
    console.error('❌ OpenAPI spec validation failed:', err)
    process.exit(1)
  }
}

validateDocs()
