// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Sighting",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Sighting",
            path: "Sources/Sighting"
        )
    ]
)
