# Serverless Orders API

## Project objective

This project demonstrates how to build and evolve a serverless order service on AWS. It stores order items in DynamoDB, exposes create and read operations through an API Gateway REST API, and adds authentication, request protection, monitoring, and an automated deployment workflow.

The project also records optimization and resilience ideas, including DynamoDB Accelerator (DAX), API Gateway caching, and DynamoDB Global Tables. These are documented separately from the features that are currently deployed, because account restrictions and CloudFormation migration constraints prevented some of them from being activated.

## Architecture

### Current AWS deployment

![AWS architecture diagram for the currently deployed Orders API](docs/orders-architecture.svg)

The diagram uses AWS architecture service icons. The diagram file is self-contained so it can be displayed directly by GitHub without loading external image links. Icon source: [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/), Q1 2022 package.

### Intended optimization design in the current template

```text
Client -- JWT request --> Cognito authorizer --> AWS WAF --> API Gateway
                                                              |
                                           +------------------+------------------+
                                           |                                     |
                                  POST /orders                          GET /orders/{orderId}
                                  Lambda proxy                             Lambda proxy
                                           |                                     |
                                           |                              Lambda in private VPC
                                           |                                     |
                                           |                       DAX (single dax.t3.small node)
                                           |                                     |
                                           +------ DynamoDB gateway endpoint --> DynamoDB

Private VPC: two private subnets, Lambda security group, DAX security group,
and DAX subnet group. API Gateway GET caching is configured with a 300-second
TTL and orderId as the cache key.
```

The second diagram describes the design in the template and source code, not the live AWS deployment. DAX provisioning failed for this account, so the stack rolled back before those resources were created.

## How the project was developed

1. **Order storage:** Created the `Orders` DynamoDB table with `orderId` as the string partition key, `itemId` as the string sort key, and on-demand billing. This supports storing multiple items for one order without pre-provisioning read/write capacity.
2. **Order creation:** Added a Node.js 22 Lambda handler that validates `orderId` and `itemId` and writes each item with DynamoDB `PutItem`. Its IAM permissions are scoped to the table.
3. **REST API:** Added `POST /orders` to create orders and `GET /orders/{orderId}` to retrieve an order's items. The currently deployed GET method directly integrates API Gateway with DynamoDB `Query`, so it does not invoke Lambda.
4. **Authentication and request protection:** Added a Cognito User Pool authorizer and a regional AWS WAF rate-based rule configured to block an IP after 1,000 requests in the five-minute evaluation window. User creation is admin-only. A Cognito hosted login domain was not configured.
5. **Observability:** Added a CloudWatch dashboard for API Gateway `Count` and `4XXError`, and Lambda `Invocations` and `Errors`. Enabled active X-Ray tracing on the Lambda.
6. **Build and delivery:** Configured SAM/esbuild to minify the Lambda bundle. Added a GitHub Actions workflow to build and deploy on pushes to `main` or manual dispatch, using GitHub OIDC to assume an AWS role.
7. **Read-performance experiment:** Changed the source design so Lambda handles GET reads through DAX and configured API Gateway caching with the order ID as the cache key and a 300-second TTL. This requires a VPC for Lambda and DAX, so the template also describes private subnets, security groups, and a DynamoDB gateway endpoint.
8. **Multi-Region experiment:** Considered DynamoDB Global Tables with a replica in `eu-west-1`. CloudFormation rejected changing the existing table resource type in place, so that change was reverted. The current template enables a `NEW_AND_OLD_IMAGES` stream, but does not configure a replica.

## Current feature status

Status reflects the project files and AWS stack `orders-table-stack` in `us-east-1`, last checked on 2026-10-27.

| Capability | Project files | AWS deployment |
|---|---|---|
| DynamoDB `Orders` table, composite key, on-demand capacity | Configured | Active regional table |
| `POST /orders` through Lambda | Configured | Deployed and Cognito-protected |
| `GET /orders/{orderId}` | Source/template route through Lambda and DAX | Deployed as direct API Gateway-to-DynamoDB Query |
| Cognito User Pool authorizer | Configured; admin-created users | Deployed |
| Hosted Cognito login page | Not configured | Not available |
| WAF rate limiting | Configured at 1,000 requests per IP | Deployed and associated with API stage |
| CloudWatch dashboard | Configured | Deployed as `OrdersApiDashboard` |
| Lambda active X-Ray tracing | Configured | Enabled |
| API Gateway GET caching | Configured for 300 seconds | Not deployed; stage cache is disabled |
| DAX and supporting VPC | Configured in template/source | Not deployed; stack update rolled back |
| DynamoDB Streams | `NEW_AND_OLD_IMAGES` configured | Not deployed; live table has no stream |
| DynamoDB Global Table replica | Not configured | Not deployed |
| GitHub Actions deployment | Workflow configured | Push to `main` starts a deployment workflow |

The latest observed CloudFormation stack status is `UPDATE_ROLLBACK_COMPLETE`. The DAX attempt failed while creating the DAX subnet group with an AWS error stating that the access key needs a subscription for DAX. The live Lambda is active on Node.js 22, has active tracing, and has `TABLE_NAME=Orders`; it has no DAX endpoint and is not VPC-attached. The live DynamoDB table has no stream or replica.

## API details

Base URL:

```text
https://wgybxq9dkf.execute-api.us-east-1.amazonaws.com/Prod
```

| Method and path | Purpose | Live integration |
|---|---|---|
| `POST /orders` | Save an order item | Lambda proxy; Lambda writes with DynamoDB `PutItem` |
| `GET /orders/{orderId}` | Retrieve all items for an order | API Gateway calls DynamoDB `Query` directly |

Both routes require a valid Cognito User Pool token in the `Authorization` header:

```http
Authorization: Bearer <cognito-id-token>
```

The POST body is JSON with non-empty string values for `orderId` and `itemId`. Other JSON properties are saved on the item. Lambda returns `201` after saving, or `400` for invalid JSON or missing/invalid keys.

The User Pool is configured for administrator-created users only. The project does not configure a hosted UI domain or a user-facing login page.

## Optimization and resilience options

### DAX and API Gateway caching

DAX can cache DynamoDB reads for applications that need lower read latency, and API Gateway caching can reuse responses for repeated GET requests. In this project, DAX would require Lambda and DAX to run inside a VPC; API Gateway caching is separately configured for the GET route with a 300-second TTL.

These resources are **not deployed**. AWS rejected DAX provisioning for this account. DAX nodes and API Gateway stage caches can incur ongoing charges; the configured single `dax.t3.small` node does not provide node-level high availability. Check account eligibility, service availability, and pricing before enabling this design. The Node.js DAX client also depends on AWS SDK for JavaScript v2, which is end-of-support; npm audit reported moderate advisories in the dependency chain with no fixes available.

For a simpler deployment, remove the DAX resources, DAX-specific VPC/security/IAM configuration, and DAX client usage; keep the direct API Gateway-to-DynamoDB GET integration. Disable API Gateway caching if its cost is not appropriate.

### DynamoDB Global Tables

The deployed `Orders` table is regional. CloudFormation rejected an attempt to change the existing resource from `AWS::DynamoDB::Table` to `AWS::DynamoDB::GlobalTable` with “Update of resource type is not permitted.” That change was reverted.

For multi-Region disaster recovery, use a separate migration: create a separately named Global Table, copy and verify existing data, update the application to use it, and retire the original table only after a validated cutover. Global Table replication is asynchronous and incurs costs in each Region. The current template does not create a replica.

## Build and deploy

Prerequisites: Node.js 22, npm, AWS SAM CLI, and AWS credentials authorized to deploy the stack.

In PowerShell, from the project directory:

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

`sam build` is local and does not change AWS resources. Add the esbuild executable directory to `PATH` as shown if SAM cannot locate esbuild.

To deploy the existing stack:

```powershell
sam deploy --stack-name orders-table-stack --region us-east-1 --resolve-s3 --capabilities CAPABILITY_IAM
```

Review the CloudFormation change set before approving it. With the current template, DAX provisioning is expected to roll back until account access is resolved or the DAX design is removed.

## Automated deployment

`.github/workflows/deploy.yml` runs on pushes to `main` and on manual dispatch. It:

1. Checks out the repository and configures Node.js 22 and AWS SAM CLI.
2. Installs the locked Lambda dependencies with `npm ci`.
3. Uses GitHub OIDC to assume `arn:aws:iam::525391386782:role/GitHubActions-OrdersAPI-Deploy`.
4. Builds and deploys `orders-table-stack` in `us-east-1`.

The AWS role trust policy must allow GitHub Actions from this repository to assume it. A push to `main` deploys automatically; the DAX account restriction can cause that deployment to fail until resolved or the DAX resources are removed.

## Repository layout

```text
.
├── .github/
│   └── workflows/
│       └── deploy.yml       # CI/CD build and deployment
├── src/
│   ├── index.js             # Lambda handler
│   ├── package.json         # Runtime and build dependencies
│   └── package-lock.json    # Locked npm dependency graph
├── template.yaml            # SAM and CloudFormation resources
└── README.md                # Project objective, architecture, and development history
```
