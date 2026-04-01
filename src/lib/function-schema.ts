function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normalizeSchemaNode)
  }

  if (!isRecord(node)) {
    return node
  }

  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isRecord(value)) {
      normalized[key] = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [
          propertyName,
          normalizeSchemaNode(propertySchema),
        ]),
      )
      continue
    }

    normalized[key] = normalizeSchemaNode(value)
  }

  if (node.type === 'object' || isRecord(normalized.properties)) {
    normalized.required = isRecord(normalized.properties)
      ? Object.keys(normalized.properties)
      : []
  }

  return normalized
}

export function normalizeFunctionParametersSchemaForCopilot<T extends Record<string, unknown> | null | undefined>(
  schema: T,
): T {
  if (!schema) {
    return schema
  }

  return normalizeSchemaNode(schema) as T
}
