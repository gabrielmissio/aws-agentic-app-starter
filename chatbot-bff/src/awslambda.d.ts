/**
 * Type declarations for the Lambda Node.js runtime `awslambda` global.
 * Used with `streamifyResponse()` for response streaming via
 * Lambda Function URLs or API Gateway REST API (ResponseTransferMode: RESPONSE_STREAM).
 *
 * @see https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html
 */
import type { Writable } from 'node:stream'

declare global {
  namespace awslambda {
    function streamifyResponse(
      handler: (event: unknown, responseStream: Writable, context: unknown) => Promise<void>,
    ): (event: unknown, context: unknown) => Promise<void>

    namespace HttpResponseStream {
      function from(responseStream: Writable, metadata: HttpResponseMetadata): Writable
    }

    interface HttpResponseMetadata {
      statusCode: number
      headers?: Record<string, string>
    }
  }
}
