import { parse, printParseErrorCode } from "jsonc-parser"

export function parseCloudflareConfig(source) {
  const errors = []
  const config = parse(source, errors, { allowTrailingComma: true })
  if (errors.length)
    throw new Error(
      `Invalid wrangler.jsonc: ${printParseErrorCode(errors[0].error)}`
    )
  return config
}
