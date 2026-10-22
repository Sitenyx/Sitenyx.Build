# Sitenyx.Build

Shared build configuration: NuGet versions for every Sitenyx microservice via MSBuild Central Package Management (CPM).

## Usage

### Adding to a New Microservice

1. **Add as git submodule:**
   ```bash
   cd YourGate
   git submodule add https://github.com/Sitenyx/Sitenyx.Build.git build
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
       <TargetFramework>net10.0</TargetFramework>
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
git pull origin master
cd ..
git add build
git commit -m "Update Sitenyx.Build to latest"
```

Pushing this commit deploys the Gate — see Version Management.

### Cloning a Repository with Submodules

When cloning a microservice repository:

```bash
# Option 1: Clone with submodules
git clone --recurse-submodules https://github.com/Sitenyx/YourGate.git

# Option 2: Initialize after cloning
git clone https://github.com/Sitenyx/YourGate.git
cd YourGate
git submodule init
git submodule update
```

## CI/CD Setup

Gates call `sitenyx-infra/.github/workflows/{test,deploy}-dotnet.yml`, which check out submodules recursively; nothing to add per Gate.

## Version Management

### Updating Shared Package Versions

1. Clone this repository
2. Update version in `Directory.Packages.props`
3. Commit and push to `master`
4. Each Gate can then bump its `build` submodule pin — committing and pushing that bump deploys the Gate to production: ask first; pacing per Sitenyx `CLAUDE.md` §5

- A Core publish (`Core/build-and-update-sdks.sh --publish-core`, skill `sitenyx-core-publish`) bumps the four `Sitenyx.*` pins (below), then commits and pushes this repo's `master`; it aborts if this repo is dirty, off `master` or diverged.
- `scripts/` = CI audit lints that sitenyx-infra `test-dotnet.yml` runs from `build/scripts/`; a Gate gets a new one only via its `build` pin.

### Service-Specific Version Overrides

If a service needs a different version of a shared package, override it in that service's `Directory.Packages.props`:

```xml
<Project>
  <ItemGroup>
    <!-- Override shared version -->
    <PackageVersion Update="OpenIddict.Core" Version="<version>" />
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
- **Authentication** - OpenIddict
- **Logging** - Serilog, Datadog
- **Multi-Tenancy** - Finbuckle.MultiTenant
- **Service Discovery** - Consul, Steeltoe, YARP
- **Message Bus** - Rebus
- **Caching** - Redis, StackExchange.Redis
- **Sitenyx Internal** - `Sitenyx.Core`, `Sitenyx.Shared`, `Sitenyx.Core.Testing`, `Sitenyx.Analyzers`; Gate SDK pins stay in each Gate's own `Directory.Packages.props`

## Microservices

This shared configuration is consumed by **every Sitenyx .NET backend microservice** —
all of the Gates listed in the platform service inventory (`AGENTS.md`) — plus the shared
`Core` framework. It is imported as the `build` submodule in each service's
`Directory.Build.props`. Exceptions: AgentGate (no `build/` yet — local pins) and PromoGate
(`build/` is a flattened copy, not a submodule).

Not consumers: the two Next.js frontends (AdminGate, ClientGate) manage their own npm
dependencies and do not use this MSBuild package config.

## Troubleshooting

### Submodule not initialized
```bash
git submodule update --init --recursive
```

### Package version conflicts
Check for duplicate `PackageVersion` entries in both shared and local `Directory.Packages.props`. Override with `<PackageVersion Update="<Id>" Version="…" />`, never a second `Include`.

### Build errors after submodule update
```bash
# Clean and restore
dotnet clean
dotnet restore
dotnet build
```

## Contributing

Keep a new or bumped version compatible across every Gate and test it in at least one Gate before committing.

## License

Internal use only - Sitenyx Project

