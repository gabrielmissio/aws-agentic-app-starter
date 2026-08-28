import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import { cp, SEED_CATALOG } from './domain'

/**
 * Post-deploy seed: the demo catalog plus one sandbox payment method.
 *
 * Run once after `cdk deploy` (`npm --prefix ./ap2-core run seed`). The catalog has to exist before
 * the agent can search anything; the sandbox method is only needed when
 * `AUTO_PROVISION_SANDBOX_METHOD` is off, since otherwise the CP mints one on first listing.
 */
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }))

async function main() {
  const projectName = process.env.PROJECT_NAME
  const catalog = process.env.TABLE_CATALOG ?? (projectName ? `${projectName}-merchant-catalog` : undefined)
  const registry = process.env.TABLE_PM_REGISTRY ?? (projectName ? `${projectName}-payment-methods-registry` : undefined)
  if (!catalog || !registry) {
    throw new Error('Set PROJECT_NAME in infra/.env, or set TABLE_CATALOG and TABLE_PM_REGISTRY directly')
  }

  for (const item of SEED_CATALOG) {
    await doc.send(new PutCommand({ TableName: catalog, Item: item }))
  }

  const userId = process.env.SEED_USER_ID
  if (userId) {
    await doc.send(new PutCommand({ TableName: registry, Item: cp.makeSandboxMethod(userId) }))
  }

  console.log(
    `seeded ${SEED_CATALOG.length} products` +
      (userId ? ` + a sandbox payment method for ${userId}` : ' (no SEED_USER_ID — skipped the method)'),
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
