# Serverless Orders API

AWS SAM project for storing and retrieving order items in DynamoDB. The table uses `orderId` as its partition key and `itemId` as its sort key. The API is protected by Amazon Cognito and an AWS WAF rate-based rule.

> **Deployment status:** The deployed stack is not identical to the current template. The latest DAX/VPC deployment rolled back because AWS rejected DAX service access for this account. This README calls out the live configuration separately from the configuration currently described by `template.yaml`.

## Architecture

### Currently deployed in AWS (`us-east-1`)

```mermaid
flowchart LR
    Client[Client]
    Cognito[Amazon Cognito<br/>User Pool authorizer]
    WAF[AWS WAF<br/>1000 requests per IP / 5 min]
    API[API Gateway REST API<br/>Prod stage]
    Lambda[SaveOrderFunction<br/>Node.js 22]
    DDB[(DynamoDB<br/>Orders table)]
    Dashboard[CloudWatch dashboard]
    XRay[AWS X-Ray]

    Client -->|authenticate| Cognito
    Cognito -->|JWT token| Client
    Client -->|request with JWT| WAF
    WAF --> API
    API -->|POST /orders<br/>Lambda proxy| Lambda
    Lambda -->|PutItem| DDB
    API -->|GET /orders/{orderId}<br/>DynamoDB Query integration| DDB
    API -. metrics .-> Dashboard
    Lambda -. invocations and errors .-> Dashboard
    Lambda -. active tracing .-> XRay
```

### Intended by the current template (not fully deployed)

```mermaid
flowchart LR
    Client[Client]
    Cognito[Cognito authorizer]
    WAF[AWS WAF]
    API[API Gateway REST API<br/>GET cache TTL 300 seconds]
    Lambda[SaveOrderFunction<br/>Node.js 22]
    DDB[(Orders DynamoDB table)]
    subgraph VPC[Private VPC created by the template]
        Lambda
        DAX[DynamoDB Accelerator<br/>single dax.t3.small node]
        Lambda -->|GET query| DAX
    end
    DAX --> DDB
    Lambda -->|POST PutItem through<br/>DynamoDB gateway endpoint| DDB
    Client -->|authenticate| Cognito
    Cognito -->|JWT token| Client
    Client -->|request with JWT| WAF
    WAF --> API
    API -->|POST /orders| Lambda
    API -->|GET /orders/{orderId}| Lambda
```

## Feature status

Status checked against the AWS account and stack `orders-table-stack` in `us-east-1` on 2026-10-27.

| Feature | In the current template/source | Deployed status |
|---|---|---|
| DynamoDB `Orders` table, composite key, on-demand billing | Yes | Active in `us-east-1` |
| `POST /orders` creates an item through Lambda | Yes | Deployed; Cognito-protected |
| `GET /orders/{orderId}` reads order items | Template routes through Lambda/DAX | Deployed as a direct API Gateway-to-DynamoDB `Query` integration; does not invoke Lambda |
| Cognito User Pool authorizer | Yes; admin-created users only by default | Deployed |
| Hosted Cognito login page/domain | Not configured | Not available |
| WAF rate limiting | 1,000 requests per IP over the five-minute evaluation window | Deployed and associated with the API stage |
| CloudWatch dashboard | API Gateway `Count`/`4XXError`, Lambda `Invocations`/`Errors` | Deployed as `OrdersApiDashboard` |
| Lambda X-Ray active tracing | Yes | Enabled on deployed Lambda |
| API Gateway stage cache | GET caching configured with order ID cache key and 300-second TTL | Not deployed; stage cache is disabled |
| DAX-backed Lambda reads and VPC | Configured in template/source | Not deployed; CloudFormation rolled back |
| DynamoDB Streams | `NEW_AND_OLD_IMAGES` configured in template | Not deployed; the live table has no stream |
| DynamoDB Global Table replica | Not configured in the current template | Not deployed |
| GitHub Actions deployment | Push to `main` and manual dispatch | Workflow is present; deployment requires the configured AWS OIDC role |

The latest stack status is `UPDATE_ROLLBACK_COMPLETE`. Its deployed API still has both `POST /orders` and `GET /orders/{orderId}`. The live GET method directly queries DynamoDB using an API Gateway IAM role. The deployed Lambda is active on Node.js 22, has active X-Ray tracing, and currently has `TABLE_NAME=Orders` without a DAX endpoint.

## API

Base URL:

```text
https://wgybxq9dkf.execute-api.us-east-1.amazonaws.com/Prod
```

| Method and path | Purpose | Deployed integration |
|---|---|---|
| `POST /orders` | Save an order item | Lambda proxy; Lambda uses DynamoDB `PutItem` |
| `GET /orders/{orderId}` | Retrieve items for an order | API Gateway directly calls DynamoDB `Query` |

Both methods require a valid Cognito User Pool token. Send it as:

```http
Authorization: Bearer <cognito-id-token>
```

The `POST` body must be JSON containing non-empty string keys `orderId` and `itemId`. Other JSON properties are saved as part of the item. Lambda returns `201` when the item is written and `400` for invalid JSON or missing/invalid keys.

The User Pool is admin-managed (`AllowAdminCreateUserOnly: true`). There is no hosted UI domain, so users must be created and authenticated through a configured client/application flow before calling the API.

## Components and design choices

- **DynamoDB:** `Orders` is an on-demand (`PAY_PER_REQUEST`) regional table in `us-east-1`, with `orderId` (string) as the partition key and `itemId` (string) as the sort key.
- **Lambda:** `src/index.js` handles order writes and, in the current source, DAX-backed order reads. AWS SDK/DAX clients are initialized outside the handler for reuse between warm invocations.
- **IAM:** Lambda has `PutItem` access to the table. The direct API Gateway GET integration uses a role with `dynamodb:Query` access to the table. DAX access and VPC execution permissions are in the proposed template.
- **Cognito:** Default API authorizer; user creation is restricted to administrators. Hosted login is not configured.
- **WAF:** Regional Web ACL blocks IPs exceeding the configured rate limit.
- **Monitoring:** CloudWatch dashboard and active Lambda X-Ray tracing.
- **Build optimization:** SAM/esbuild minifies the Lambda bundle. The AWS SDK modules used by the original handler are externalized to use the Node.js 22 runtime SDK; the DAX client currently adds the legacy AWS SDK for JavaScript v2 dependency.
- **CI/CD:** `.github/workflows/deploy.yml` runs for pushes to `main` and manual dispatch. It uses GitHub OIDC to assume `arn:aws:iam::525391386782:role/GitHubActions-OrdersAPI-Deploy`, installs dependencies with `npm ci`, builds with SAM, and deploys to `us-east-1`.

## DAX and API caching: optional optimization

The current template configures:

- A private VPC with two private subnets.
- A DynamoDB gateway endpoint so the VPC-attached Lambda can continue writing to DynamoDB without a NAT gateway.
- A single-node `dax.t3.small` DAX cluster for Lambda reads.
- API Gateway stage caching for `GET /orders/{orderId}` with the order ID as a cache key and a 300-second TTL.

**This configuration is not deployed.** CloudFormation failed while creating the DAX subnet group with an AWS error stating that the access key needs a subscription for DAX. The stack rolled back. Resolve DAX account/service access before attempting deployment again, or remove DAX and its associated VPC/security/IAM resources and restore a DynamoDB-only GET integration.

DAX and API Gateway caching can incur ongoing charges. A single DAX node does not provide node-level high availability. API Gateway stage caching also has a cost. Check current AWS pricing and service/account eligibility before enabling these resources. The current Node.js DAX client (`amazon-dax-client`) depends on AWS SDK for JavaScript v2, which is end-of-support; npm audit reported moderate advisories in that dependency chain with no fixes available.

## Global Tables and disaster recovery

The deployed `Orders` table is a regional table. The current template retains `AWS::DynamoDB::Table` and enables `NEW_AND_OLD_IMAGES` streams, but that stream update has not deployed. There is no replica configured in `eu-west-1`.

An earlier attempt to change the existing CloudFormation resource from `AWS::DynamoDB::Table` to `AWS::DynamoDB::GlobalTable` was rejected during change-set creation with **“Update of resource type is not permitted.”** The change was reverted. Do not change the existing resource type in place: create a separately named Global Table, copy and verify data, cut the application over, then retire the original table if multi-Region replication is required. Global Tables replicate asynchronously and add costs in each Region.

## Build and deploy

Prerequisites: Node.js 22, npm, AWS SAM CLI, and AWS credentials authorized to deploy this stack.

### PowerShell build

From the project directory:

```powershell
cd "C:\path\to\SERVERLESS_APP"
$env:Path = "C:\Program Files\nodejs;$env:Path"

Push-Location .\src
npm ci
if ($LASTEXITCODE -ne 0) {
    Pop-Location
    throw "npm ci failed"
}
Pop-Location

$env:Path = "$PWD\src\node_modules\.bin;$env:Path"
sam validate --template-file template.yaml --lint
sam build
```

The esbuild path is added explicitly because some PowerShell sessions do not expose Node/npm/esbuild on `PATH` automatically. `sam build` does not change AWS resources.

### Deploy

```powershell
sam deploy --stack-name orders-table-stack --region us-east-1 --resolve-s3 --capabilities CAPABILITY_IAM
```

Review the CloudFormation change set before approving it. The current template includes DAX resources, so deployment is expected to roll back until the account's DAX access issue is resolved or the DAX configuration is removed.

## Repository layout

```text
.
├── .github/
│   └── workflows/
│       └── deploy.yml       # GitHub Actions build and deployment workflow
├── src/
│   ├── index.js             # Lambda handler
│   ├── package.json         # Runtime and build dependencies
│   └── package-lock.json    # Locked npm dependency graph
├── template.yaml            # SAM and CloudFormation resources
└── README.md
```
