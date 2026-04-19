# Code size comparison

This is a simple code size comparison between Protobuf-ES and google-protobuf.

We are generating code for the module [buf.build/bufbuild/buf](https://buf.build/bufbuild/buf)
once with `protoc-gen-js` from [github.com/protocolbuffers/protobuf-javascript](https://github.com/protocolbuffers/protobuf-javascript),
once with `protoc-gen-es` from Protobuf-ES. Then we bundle a [snippet of code that imports from one generated file](./src/gen/protobuf-es/entry-1.ts)
with [esbuild](https://esbuild.github.io/), minify the bundle, and compress it like a web server would
usually do. We repeat this for an increasing number of files.

![chart](./chart.svg)

<details><summary>Tabular data</summary>

<!-- TABLE-START -->

| code generator      | files | bundle size |  minified | compressed |
| ------------------- | ----: | ----------: | --------: | ---------: |
| Protobuf-ES         |     1 |   142,632 b |  72,245 b |   16,533 b |
| Protobuf-ES         |     4 |   144,821 b |  73,753 b |   17,219 b |
| Protobuf-ES         |     8 |   147,583 b |  75,524 b |   17,750 b |
| Protobuf-ES         |    16 |   158,033 b |  83,505 b |   20,074 b |
| Protobuf-ES         |    32 |   185,824 b | 105,523 b |   25,528 b |
| protobuf-javascript |     1 |   314,120 b | 244,024 b |   35,999 b |
| protobuf-javascript |     4 |   340,137 b | 258,996 b |   37,473 b |
| protobuf-javascript |     8 |   360,931 b | 270,573 b |   38,585 b |
| protobuf-javascript |    16 |   518,906 b | 363,964 b |   45,793 b |
| protobuf-javascript |    32 | 1,286,214 b | 854,395 b |   75,520 b |

<!-- TABLE-END -->

</details>
