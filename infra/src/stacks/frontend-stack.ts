import * as cdk from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import { Construct } from 'constructs'
import type { MfaMode } from '../config.js'

/**
 * Where the app's public URL is published for other stacks to read at runtime (not at synth time —
 * see the note by `AppUrlParameter` below). A plain string function, not a construct: importing it
 * elsewhere creates no CDK cross-stack reference, just agreement on a parameter name.
 */
export function appUrlParameterName(projectName: string): string {
  return `/${projectName}/app-url`
}

export interface FrontendStackProps extends cdk.StackProps {
  projectName: string
  /**
   * The BFF API base URL — injected into the runtime config so the SPA
   * knows where to POST /chat requests.
   */
  bffUrl: string
  // Cognito values written into a runtime config object served from S3
  cognitoUserPoolId: string
  cognitoUserPoolClientId: string
  cognitoRegion: string
  /** Mirrors AuthStackProps.publicSignUpEnabled — tells the SPA which auth screen to render. */
  publicSignUpEnabled: boolean
  /**
   * Mirrors `AuthStackProps.mfa`. The SPA needs it because the three modes are three different
   * products: `off` has no enrollment at all, `required` enrolls at sign-in, and `optional` is the
   * only one where a signed-in user has to be *offered* a second factor — without knowing which,
   * the app would either hide a control people need or show one Cognito refuses.
   */
  mfa?: MfaMode
  /**
   * Mirrors AuthStackProps.retainData. The bucket only holds a rebuildable static build, so this is
   * mostly about not orphaning it on every disposable-environment teardown — unlike the user pool,
   * losing it costs nothing but a redeploy.
   */
  retainData?: boolean
}

export class FrontendStack extends cdk.Stack {
  public readonly distributionUrl: string

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props)

    const {
      projectName,
      bffUrl,
      cognitoUserPoolId,
      cognitoUserPoolClientId,
      cognitoRegion,
      publicSignUpEnabled,
      mfa = 'off',
      retainData = true,
    } = props

    // ── S3 bucket (private — no public access) ─────────────────────────
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `${projectName}-frontend-${this.account}`,
      // No `blockPublicAccess`: S3 blocks public access by default on new buckets, and setting it
      // explicitly needs `s3:PutBucketPublicAccessBlock`, which some SCPs deny. Add
      // `blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL` if your account allows the call and you
      // want the setting pinned rather than inherited.
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      // Only safe alongside DESTROY: emptying a bucket you are about to retain would just leave an
      // empty one behind, defeating the point.
      autoDeleteObjects: !retainData,
    })

    // ── CloudFront Origin Access Control ──────────────────────────────
    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      signing: cloudfront.Signing.SIGV4_NO_OVERRIDE,
    })

    // ── Security response headers ───────────────────────────────────────
    // The SPA keeps its Cognito tokens in localStorage (aws-amplify's default, see
    // chatbot-frontend/src/lib/auth.ts). httpOnly cookies would need the tokens brokered
    // server-side; a strict CSP instead closes the injection point that would read them —
    // `script-src 'self'` with no `'unsafe-inline'`/`'unsafe-eval'` blocks the injected-script class
    // of attack outright.
    //
    // `style-src` needs `'unsafe-inline'` because several components set React inline `style={{...}}`,
    // which CSP treats like a `<style>` tag. `connect-src` allows only API Gateway and Cognito — the
    // AgentCore host is absent because the browser has no transport to the runtime, and listing it
    // would only widen the exfiltration surface. The `execute-api` wildcard is there because the
    // BFF's exact origin is a cross-stack CDK token here, not a plain string.
    const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${projectName}-security-headers`,
      comment: 'CSP + standard hardening headers for the chatbot SPA',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data:",
            [
              "connect-src 'self'",
              `https://*.execute-api.${cognitoRegion}.amazonaws.com`,
              `https://cognito-idp.${cognitoRegion}.amazonaws.com`,
            ].join(' '),
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "object-src 'none'",
          ].join('; '),
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    })

    // ── CloudFront distribution ────────────────────────────────────────
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${projectName} frontend`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        responseHeadersPolicy: securityHeadersPolicy,
        compress: true,
      },
      // SPA fallback — return index.html for all 403/404 so React Router works
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    })

    this.distributionUrl = `https://${distribution.distributionDomainName}`

    // ── Runtime config object ─────────────────────────────────────────
    // Deployed as /config.js — the HTML loads this before the bundle,
    // so the SPA can read window.__APP_CONFIG__ without a rebuild.
    // This is the standard pattern for injecting env vars into static SPAs
    // without baking them into the Vite bundle at build time.
    const configContent = `window.__APP_CONFIG__ = ${JSON.stringify({
      VITE_API_URL: bffUrl.replace(/\/$/, ''),
      VITE_AWS_REGION: cognitoRegion,
      VITE_COGNITO_USER_POOL_ID: cognitoUserPoolId,
      VITE_COGNITO_USER_POOL_CLIENT_ID: cognitoUserPoolClientId,
      VITE_PUBLIC_SIGNUP_ENABLED: String(publicSignUpEnabled),
      VITE_COGNITO_MFA: mfa,
    })};`

    // ── Deploy pre-built frontend assets ──────────────────────────────
    // Expects `chatbot-frontend` to be built before `cdk deploy` runs.
    // Add `npm run build` in chatbot-frontend/ to your CI pipeline first.
    //
    // Two deployments, because the two kinds of file need opposite cache headers and a single
    // `BucketDeployment` carries one `cacheControl`, so this is split in two. Stamping
    // `immutable, max-age=31536000` on index.html would be a real bug: it names the content-hashed
    // bundles, so a browser told to keep it for a year goes on requesting bundle names from a build
    // that no longer exists — and a CloudFront invalidation cannot help, because the stale copy is
    // in the browser's own cache.
    //
    // `prune: false` on both: two deployments into one bucket would each delete the other's files.

    // Content-hashed by Vite, so the filename changes whenever the bytes do. Safe to cache forever;
    // `immutable` is what stops the browser revalidating them on every reload.
    const assets = new s3deploy.BucketDeployment(this, 'DeployAssets', {
      sources: [s3deploy.Source.asset('../chatbot-frontend/dist', { exclude: ['index.html'] })],
      destinationBucket: siteBucket,
      memoryLimit: 256,
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
    })

    // The two files whose names never change, and which name everything else. `no-cache` does not
    // mean "do not store" — it means the browser must revalidate before reusing it, so a deploy is
    // picked up on the next navigation.
    const entrypoint = new s3deploy.BucketDeployment(this, 'DeployEntrypoint', {
      sources: [
        s3deploy.Source.asset('../chatbot-frontend/dist', { exclude: ['*', '!index.html'] }),
        s3deploy.Source.data('config.js', configContent),
      ],
      destinationBucket: siteBucket,
      distribution,
      // Only these need invalidating — a hashed asset is never stale, it is either present or it is
      // a new name.
      distributionPaths: ['/', '/index.html', '/config.js'],
      memoryLimit: 256,
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString('no-cache, must-revalidate')],
    })

    // index.html names the hashed bundles, so it must never land before them.
    entrypoint.node.addDependency(assets)

    // ── Grant CloudFront OAC read access to the bucket ─────────────────
    siteBucket.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ['s3:GetObject'],
        principals: [new cdk.aws_iam.ServicePrincipal('cloudfront.amazonaws.com')],
        resources: [siteBucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
          },
        },
      }),
    )

    // ── Published for the invite & verification emails ─────────────────
    // The Cognito CustomMessage trigger needs this URL, but it lives in the auth stack, which the
    // frontend stack depends on — so it cannot be handed over as a synth-time reference without a
    // cycle. SSM breaks it: the frontend writes here, the trigger reads at send time.
    new ssm.StringParameter(this, 'AppUrlParameter', {
      parameterName: appUrlParameterName(projectName),
      stringValue: this.distributionUrl,
      description: 'Public URL of the app, read by the Cognito email trigger',
    })

    // ── Outputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: this.distributionUrl,
      exportName: `${projectName}-FrontendUrl`,
    })

    new cdk.CfnOutput(this, 'BucketName', {
      value: siteBucket.bucketName,
      exportName: `${projectName}-FrontendBucket`,
    })

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      exportName: `${projectName}-DistributionId`,
    })
  }
}
