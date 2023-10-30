# 📜 Etherscript

A collection of useful scripts for interacting with EVM compatible blockchains from the command line

#### Details

## Script Glossary

### swap

Swap tokens using the uniswap sdk that leverages the smart order router to compute optimal routes and execute swaps

##### Required flags

| Parameter | Description                                       |
| --------- | ------------------------------------------------- |
| `amount`  | The human readable amount of the token to swap in |
| `in`      | The symbol of the token to swap in                |
| `out`     | The symbol of the token to swap out               |

##### Optional flags

| Parameter | Description                                      |
| --------- | ------------------------------------------------ |
| `network` | Which network to use (defaults to local hardhat) |

example usage

```
hh swap --in USDC --amount 100 --out rETH
```

## Hardhat Notes

- hardhat.config.ts specifies the settings like imports, networks, solidity verions, etc that will all be made available through the hre (hardhat runtime environment)

## Scripts Notes

- good for executing code that doesnt require parameters

```
yarn hardhat run scripts/<path-to-script>
```

## Tasks Notes

- good for executing code that requires parameters
- not allowed to import hre into scripts that are imported and used by tasks

```
yarn hardhat <task-name> <task-params>
```
