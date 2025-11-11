# Sitenyx.Build

Shared build configuration and package version management for Sitenyx microservices.

## Overview

This repository provides centralized NuGet package version management across all Sitenyx microservices using MSBuild's Central Package Management (CPM) feature.

## Usage

### Adding to a New Microservice

1. **Add as git submodule:**
   ```bash
   cd YourGate
   git submodule add https://github.com/reza-ariyan/Sitenyx.Build.git build
   git commit -m "Add Sitenyx.Build submodule"
   ```

2. **Import in `Directory.Build.props`:**
   ```xml
   <Project>
     <!-- Import shared package versions -->
     <Import Project="$(MSBuildThisFileDirectory)build/Directory.Packages.props" 
             Condition="Exists('$(MSBuildThisFileDirectory)build/Directory.Packages.props')" />
     
     <!-- Your existing Directory.Build.props content below -->
     <PropertyGroup>
       <TargetFramework>net9.0</TargetFramework>
       <!-- ... -->
     </PropertyGroup>
   </Project>
   ```

3. **Simplify your `Directory.Packages.props`:**
   
   Remove all packages that are defined in the shared config. Keep only microservice-specific packages:
   
   ```xml
   <Project>
     <!-- ManagePackageVersionsCentrally is inherited from shared config -->
     
     <ItemGroup>
       <!-- Only service-specific packages here -->
       <PackageVersion Include="YourServiceSpecific.Package" Version="1.0.0" />
     </ItemGroup>
   </Project>
   ```

### Updating the Submodule

To get the latest shared package versions:

```bash
# Pull latest shared versions
cd build
git pull origin main
cd ..
git add build
git commit -m "Update Sitenyx.Build to latest"
```

### Cloning a Repository with Submodules

When cloning a microservice repository:

```bash
# Option 1: Clone with submodules
git clone --recurse-submodules https://github.com/reza-ariyan/YourGate.git

# Option 2: Initialize after cloning
git clone https://github.com/reza-ariyan/YourGate.git
cd YourGate
git submodule init
git submodule update
```

## CI/CD Setup

Ensure your CI/CD pipeline initializes submodules:

### GitHub Actions
```yaml
- uses: actions/checkout@v4
  with:
    submodules: true
```

### GitLab CI
```yaml
variables:
  GIT_SUBMODULE_STRATEGY: recursive
```

### Azure DevOps
```yaml
- checkout: self
  submodules: true
```

## Version Management

### Updating Shared Package Versions

1. Clone this repository
2. Update version in `Directory.Packages.props`
3. Commit and push to main branch
4. Each microservice can then update its submodule reference

### Service-Specific Version Overrides

If a service needs a different version of a shared package, override it in that service's `Directory.Packages.props`:

```xml
<Project>
  <ItemGroup>
    <!-- Override shared version -->
    <PackageVersion Include="OpenIddict.Core" Version="7.1.0" Update="true" />
  </ItemGroup>
</Project>
```

## Package Categories

The shared configuration includes:

- **Azure** - Azure SDK packages (Identity, Core, Configuration)
- **Testing** - Unit testing frameworks (NUnit, xUnit, Moq, FluentAssertions, Testcontainers)
- **Core Application** - FluentValidation, MediatR, FluentResults
- **Entity Framework** - EF Core, Npgsql provider
- **ASP.NET Core** - Web framework packages
- **API Documentation** - Swagger, NSwag, Scalar
- **Authentication** - OpenIddict (v5.8.0 default, v7.x for IdGate)
- **Logging** - Serilog, Datadog
- **Multi-Tenancy** - Finbuckle.MultiTenant
- **Service Discovery** - Consul, Steeltoe, YARP
- **Message Bus** - Rebus
- **Caching** - Redis, StackExchange.Redis
- **Sitenyx Internal** - Core libraries and Gate SDKs/Contracts

## Microservices

This shared configuration is used by:

- CartGate
- IdGate (with OpenIddict 7.x override)
- OrderGate
- PaymentGate
- ProductGate
- ServiceGate
- TenantGate
- WebGate
- Core

## Troubleshooting

### Submodule not initialized
```bash
git submodule update --init --recursive
```

### Package version conflicts
Check for duplicate `PackageVersion` entries in both shared and local `Directory.Packages.props`. Use the `Update="true"` attribute to override shared versions.

### Build errors after submodule update
```bash
# Clean and restore
dotnet clean
dotnet restore
dotnet build
```

## Contributing

When adding or updating packages:

1. Ensure the version is compatible across all microservices
2. Update this README if adding a new category
3. Test the change in at least one microservice before committing
4. Use semantic versioning principles

## License

Internal use only - Sitenyx Project

