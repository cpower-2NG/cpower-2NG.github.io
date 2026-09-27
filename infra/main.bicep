@description('Azure region for all production resources.')
param location string = 'japaneast'

@description('First day of the Azure budget period.')
param budgetStartDate string = utcNow('yyyy-MM-01T00:00:00Z')

@description('Short resource prefix. Use lowercase letters and hyphens.')
@minLength(3)
@maxLength(18)
param namePrefix string = 'bifrost'

@description('Allowed browser origins for the public and admin API.')
param allowedOrigins array = [
  'https://cpower-2ng.github.io'
  'http://localhost:8000'
  'http://127.0.0.1:8000'
]

@description('GitHub owner/repository receiving synchronized content commits.')
param githubRepository string = 'cpower-2NG/cpower-2NG.github.io'

@description('Container image containing the Playwright QQ synchronizer.')
param syncImage string = 'ghcr.io/cpower-2ng/bifrost-qzone-sync:latest'

@description('Microsoft Entra tenant used by the administrator.')
param entraTenantId string

@description('Microsoft Entra SPA application client id.')
param entraClientId string

@description('API audience exposed by the Entra application.')
param entraApiAudience string

@description('Microsoft Entra object ids allowed to use the admin API.')
param adminObjectIds array

@description('GitHub App id used for short-lived repository installation tokens.')
param githubAppId string

@description('GitHub App installation id for the Pages repository.')
param githubAppInstallationId string

@description('Optional email addresses receiving Azure budget alerts.')
param budgetContactEmails array = []

@secure()
@description('GitHub App private key. Stored in Key Vault and never exposed to the browser.')
param githubAppPrivateKey string

@secure()
@description('Long random salt used for visitor and IP hashes.')
param hashSalt string

var suffix = take(uniqueString(subscription().id, resourceGroup().id, location), 6)
var storageName = 'st${take(replace(namePrefix, '-', ''), 10)}${suffix}'
var cosmosName = 'cosmos-${namePrefix}-${suffix}'
var keyVaultName = 'kv-${take(namePrefix, 12)}-${suffix}'
var logName = 'log-${namePrefix}-${suffix}'
var appInsightsName = 'appi-${namePrefix}-${suffix}'
var planName = 'plan-${namePrefix}-${suffix}'
var functionName = 'func-${namePrefix}-${suffix}'
var environmentName = 'cae-${namePrefix}-${suffix}'
var syncJobName = 'qzone-sync'
var authJobName = 'qzone-auth'
var mediaContainerName = 'media'
var privateContainerName = 'private'

resource storage 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: true
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2024-01-01' = {
  parent: storage
  name: 'default'
}

resource mediaContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: mediaContainerName
  properties: {
    publicAccess: 'Blob'
  }
}

resource privateContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: privateContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: cosmosName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    enableFreeTier: true
    enableAutomaticFailover: false
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmos
  name: 'bifrost'
  properties: {
    resource: {
      id: 'bifrost'
    }
    options: {
      throughput: 1000
    }
  }
}

resource commentsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'comments'
  properties: {
    resource: {
      id: 'comments'
      partitionKey: {
        paths: ['/path']
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          { path: '/*' }
        ]
        excludedPaths: [
          { path: '/content/?' }
        ]
      }
    }
  }
}

resource activityContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'activity'
  properties: {
    resource: {
      id: 'activity'
      partitionKey: {
        paths: ['/path']
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          { path: '/*' }
        ]
        excludedPaths: []
      }
      defaultTtl: -1
    }
  }
}

resource stateContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'state'
  properties: {
    resource: {
      id: 'state'
      partitionKey: {
        paths: ['/partitionKey']
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          { path: '/*' }
        ]
        excludedPaths: []
      }
    }
  }
}

resource rateLimitsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'rate-limits'
  properties: {
    resource: {
      id: 'rate-limits'
      partitionKey: {
        paths: ['/key']
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          { path: '/*' }
        ]
        excludedPaths: []
      }
      defaultTtl: 86400
    }
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

resource githubKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'github-app-private-key'
  properties: {
    value: githubAppPrivateKey
  }
}

resource hashSaltSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'interaction-hash-salt'
  properties: {
    value: hashSalt
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

resource functionPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: functionPlan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|22'
      alwaysOn: false
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      cors: {
        allowedOrigins: allowedOrigins
      }
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: concat(
            'DefaultEndpointsProtocol=https;AccountName=',
            storage.name,
            ';AccountKey=',
            storage.listKeys().keys[0].value,
            ';EndpointSuffix=',
            environment().suffixes.storage
          )
        }
        {
          name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING'
          value: concat(
            'DefaultEndpointsProtocol=https;AccountName=',
            storage.name,
            ';AccountKey=',
            storage.listKeys().keys[0].value,
            ';EndpointSuffix=',
            environment().suffixes.storage
          )
        }
        {
          name: 'WEBSITE_CONTENTSHARE'
          value: toLower(functionName)
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~22'
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: applicationInsights.properties.ConnectionString
        }
        {
          name: 'COSMOS_ENDPOINT'
          value: cosmos.properties.documentEndpoint
        }
        {
          name: 'COSMOS_DATABASE'
          value: 'bifrost'
        }
        {
          name: 'BLOB_ACCOUNT_URL'
          value: storage.properties.primaryEndpoints.blob
        }
        {
          name: 'MEDIA_CONTAINER'
          value: mediaContainerName
        }
        {
          name: 'PRIVATE_CONTAINER'
          value: privateContainerName
        }
        {
          name: 'KEY_VAULT_URI'
          value: keyVault.properties.vaultUri
        }
        {
          name: 'HASH_SALT'
          value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/interaction-hash-salt/)'
        }
        {
          name: 'ALLOWED_ORIGINS'
          value: join(allowedOrigins, ',')
        }
        {
          name: 'ENTRA_TENANT_ID'
          value: entraTenantId
        }
        {
          name: 'ENTRA_CLIENT_ID'
          value: entraClientId
        }
        {
          name: 'ENTRA_API_AUDIENCE'
          value: entraApiAudience
        }
        {
          name: 'ADMIN_OBJECT_IDS'
          value: join(adminObjectIds, ',')
        }
        {
          name: 'INTERACTIONS_ENABLED'
          value: 'true'
        }
        {
          name: 'SUBSCRIPTION_ID'
          value: subscription().subscriptionId
        }
        {
          name: 'RESOURCE_GROUP'
          value: resourceGroup().name
        }
        {
          name: 'SYNC_AUTH_JOB_NAME'
          value: authJobName
        }
        {
          name: 'SYNC_JOB_NAME'
          value: syncJobName
        }
      ]
    }
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2026-03-02-preview' = {
  name: environmentName
  location: location
  properties: {
    environmentMode: 'WorkloadProfiles'
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

var syncEnvironment = [
  { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
  { name: 'COSMOS_DATABASE', value: 'bifrost' }
  { name: 'BLOB_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
  { name: 'MEDIA_CONTAINER', value: mediaContainerName }
  { name: 'PRIVATE_CONTAINER', value: privateContainerName }
  { name: 'KEY_VAULT_URI', value: keyVault.properties.vaultUri }
  { name: 'GITHUB_APP_PRIVATE_KEY_SECRET_NAME', value: 'github-app-private-key' }
  { name: 'GITHUB_APP_ID', value: githubAppId }
  { name: 'GITHUB_APP_INSTALLATION_ID', value: githubAppInstallationId }
  { name: 'GITHUB_REPOSITORY', value: githubRepository }
  { name: 'GITHUB_BRANCH', value: 'main' }
  { name: 'CONTENT_COMMIT_PREFIX', value: 'content-src/imported/qq' }
  { name: 'QZONE_STATE_PARTITION', value: 'sync' }
  { name: 'PLAYWRIGHT_HEADLESS', value: 'true' }
]

resource authJob 'Microsoft.App/jobs@2024-03-01' = {
  name: authJobName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: containerEnvironment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
    }
    template: {
      containers: [
        {
          name: authJobName
          image: syncImage
          env: concat(syncEnvironment, [
            { name: 'QZONE_MODE', value: 'auth' }
          ])
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
    }
  }
}

resource syncJob 'Microsoft.App/jobs@2024-03-01' = {
  name: syncJobName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: containerEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 3600
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '0 18 * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
    }
    template: {
      containers: [
        {
          name: syncJobName
          image: syncImage
          env: concat(syncEnvironment, [
            { name: 'QZONE_MODE', value: 'sync' }
          ])
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
    }
  }
}

resource functionAuthJobOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(authJob.id, functionApp.id, 'container-apps-job-contributor')
  scope: authJob
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource functionSyncJobOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(syncJob.id, functionApp.id, 'container-apps-job-contributor')
  scope: syncJob
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource cosmosDataContributorRoleId 'Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions@2024-11-15' existing = {
  parent: cosmos
  name: '00000000-0000-0000-0000-000000000002'
}

resource functionCosmosRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, functionApp.id, cosmosDataContributorRoleId.id)
  properties: {
    roleDefinitionId: cosmosDataContributorRoleId.id
    principalId: functionApp.identity.principalId
    scope: cosmos.id
  }
}

resource authCosmosRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, authJob.id, cosmosDataContributorRoleId.id)
  properties: {
    roleDefinitionId: cosmosDataContributorRoleId.id
    principalId: authJob.identity.principalId
    scope: cosmos.id
  }
}

resource syncCosmosRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, syncJob.id, cosmosDataContributorRoleId.id)
  properties: {
    roleDefinitionId: cosmosDataContributorRoleId.id
    principalId: syncJob.identity.principalId
    scope: cosmos.id
  }
}

resource functionBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, 'storage-blob-data-contributor')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource functionBlobDelegatorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, 'storage-blob-delegator')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource syncBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, syncJob.id, 'storage-blob-data-contributor')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: syncJob.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource authBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, authJob.id, 'storage-blob-data-contributor')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: authJob.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource functionKeyVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionApp.id, 'key-vault-secrets-user')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource syncKeyVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, syncJob.id, 'key-vault-secrets-user')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: syncJob.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource authKeyVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, authJob.id, 'key-vault-secrets-user')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: authJob.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource syncKeyVaultOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, syncJob.id, 'key-vault-secrets-officer')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
    principalId: syncJob.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource authKeyVaultOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, authJob.id, 'key-vault-secrets-officer')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
    principalId: authJob.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource monthlyBudget 'Microsoft.Consumption/budgets@2023-11-01' = if (length(budgetContactEmails) > 0) {
  name: 'bifrost-monthly-budget'
  properties: {
    category: 'Cost'
    amount: 20
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
      endDate: '2036-01-01T00:00:00Z'
    }
    notifications: {
      fiftyPercent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 50
        contactEmails: budgetContactEmails
        thresholdType: 'Actual'
      }
      eightyPercent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        contactEmails: budgetContactEmails
        thresholdType: 'Actual'
      }
      oneHundredPercent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        contactEmails: budgetContactEmails
        thresholdType: 'Actual'
      }
    }
  }
}

output functionAppName string = functionApp.name
output functionAppHostName string = functionApp.properties.defaultHostName
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output blobEndpoint string = storage.properties.primaryEndpoints.blob
output keyVaultUri string = keyVault.properties.vaultUri
output syncJobName string = syncJob.name
output authJobName string = authJob.name
