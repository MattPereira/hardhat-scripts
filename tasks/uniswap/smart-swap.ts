import chalk from "chalk";
import { task, types } from "hardhat/config";
import { BaseProvider } from "@ethersproject/providers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { config as envEncConfig } from "@chainlink/env-enc";
import ERC20_ABI from "@chainlink/contracts/abi/v0.8/ERC20.json";
import { wrapETH, approveToken, getTokenMetadata } from "../helpers";
import { logTxHashLink, prompt, getGasSpentInUSD } from "../../utils";
import { addressBook } from "../../addressBook";

import { Percent, CurrencyAmount, TradeType, Token } from "@uniswap/sdk-core";
import {
  AlphaRouter,
  SwapOptionsSwapRouter02,
  SwapType,
  SwapRoute,
} from "@uniswap/smart-order-router";

envEncConfig();

/** Swap tokens using uniswap's smart order router to compute the optimal routes
 *
 * https://docs.uniswap.org/sdk/v3/guides/swaps/routing
 */

task(
  "smart-swap",
  "execute a swap between two tokens using the uniswap smart order router"
)
  .addParam(
    "in",
    "The symbol of the token to swap in",
    undefined,
    types.string,
    false
  )
  .addParam(
    "amount",
    "The human readable amount of the token to swap in",
    undefined,
    types.int,
    false
  )
  .addParam(
    "out",
    "The symbol of the token to swap out",
    undefined,
    types.string,
    false
  )
  .setAction(async (taskArgs, hre) => {
    if (hre.network.name === "hardhat") {
      console.log("Simulating swap on local fork...");
    } else {
      console.log("Executing swap on live network...");
    }

    const chainId = (await hre.ethers.provider.getNetwork()).chainId;
    const tokenInSymbol =
      taskArgs.in.toUpperCase() as keyof typeof tokenAddress;
    const tokenOutSymbol =
      taskArgs.out.toUpperCase() as keyof typeof tokenAddress;

    // sanitize & validate the token symbols passed via command line
    const tokenList = Object.keys(addressBook[chainId].tokenAddress);
    if (!tokenList.includes(tokenInSymbol)) {
      throw new Error(`Invalid in token: ${taskArgs.in}`);
    }
    if (!tokenList.includes(tokenOutSymbol)) {
      throw new Error(`Invalid out token: ${taskArgs.out}`);
    }

    console.log("Fetching token metadata...");
    const tokenAddress = addressBook[chainId].tokenAddress;
    const tokenIn = await getTokenMetadata(tokenAddress[tokenInSymbol], hre);
    const tokenOut = await getTokenMetadata(tokenAddress[tokenOutSymbol], hre);
    const amountIn = taskArgs.amount.toString();

    // If on local fork, wrap 1 eth and exchange for tokenIn to prepare for actual target swap
    if (hre.network.name === "hardhat") {
      const amount = "1";
      await wrapETH(hre, amount);
      const WETH_TOKEN = await getTokenMetadata(tokenAddress["WETH"], hre);
      const route = await generateRoute(WETH_TOKEN, amount, tokenIn, hre);
      await executeSwap(route, hre);
    }

    // Execute the target swap as defined by taskArgs
    const route = await generateRoute(tokenIn, amountIn, tokenOut, hre);
    await executeSwap(route, hre);
  });

/** Function to generate the optimal route for the swap
 * @param tokenIn the token to sell into the liquidity pool
 * @param amountIn human readable amount to sell of tokenIn
 * @param tokenOut the token received from the liquidity pool
 * @param hre the hardhat runtime environment
 * @returns route optimal route for the swap
 */

async function generateRoute(
  tokenIn: Token,
  amountIn: string,
  tokenOut: Token,
  hre: HardhatRuntimeEnvironment
): Promise<SwapRoute> {
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;

  let provider: BaseProvider;
  if (hre.network.name === "hardhat") {
    // uniswap router requires a live network provider (localhost fork not supported)
    provider = new hre.ethers.providers.JsonRpcProvider(
      (hre.network.config as any).forking.url
    );
  } else {
    // use the default provider if on live network
    provider = hre.ethers.provider;
  }

  const router = new AlphaRouter({
    chainId,
    provider,
  });

  const signerAddress = await hre.ethers.provider.getSigner(0).getAddress();
  const options: SwapOptionsSwapRouter02 = {
    recipient: signerAddress, // Recipient of the output tokens
    slippageTolerance: new Percent(50, 10_000), // 50 bips, or 0.50%
    deadline: Math.floor(Date.now() / 1000 + 1800), // 30 minutes from the current Unix time
    type: SwapType.SWAP_ROUTER_02, // Uniswap v3 Swap Router
  };

  // Generate the route using tokenIn, tokenOut, and options
  const route = await router.route(
    CurrencyAmount.fromRawAmount(
      tokenIn,
      hre.ethers.utils.parseUnits(amountIn, tokenIn.decimals).toString()
    ),
    tokenOut,
    TradeType.EXACT_INPUT,
    options
  );

  if (!route) {
    throw new Error("No route found for the specified swap.");
  }

  return route;
}

/** Function that approves the router to spend the tokenIn and executes the swap
 * @param route the swap route generated by the smart order router
 * @param hre the hardhat runtime environment
 */

async function executeSwap(route: SwapRoute, hre: HardhatRuntimeEnvironment) {
  const { ethers } = hre;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const V3_SWAP_ROUTER_ADDRESS = addressBook[chainId].uniswap.V3_SWAP_ROUTER;
  const tokenIn = route.trade.routes[0].input;
  const amountIn = route.trade.swaps[0].inputAmount.toExact();
  const tokenOut = route.trade.routes[0].output;
  const txCost = (+route.estimatedGasUsedUSD.toExact()).toFixed(2);

  //prettier-ignore
  const quoteMessage = chalk.yellow(`Swap ${amountIn} ${tokenIn.symbol} to ${route?.quote.toExact()} ${tokenOut.symbol} using $${txCost} worth of gas?`);
  console.log();
  await prompt(quoteMessage);

  // Approve tokenIn to be transferred by the router
  await approveToken(
    (tokenIn as Token).address,
    V3_SWAP_ROUTER_ADDRESS,
    amountIn,
    hre
  );

  // Calculate gas fee configuration
  const { maxFeePerGas, maxPriorityFeePerGas } =
    await ethers.provider.getFeeData();
  if (!maxFeePerGas || !maxPriorityFeePerGas) {
    throw new Error("Failed to fetch gas fee data");
  }

  if (!route.methodParameters)
    throw new Error("Failed to fetch route.methodParameters");

  console.log("Sending swap transaction...");
  const signer = (await ethers.getSigners())[0];
  const swapTx = await signer.sendTransaction({
    data: route.methodParameters.calldata,
    to: V3_SWAP_ROUTER_ADDRESS,
    value: route.methodParameters.value,
    from: signer.address,
    maxFeePerGas: maxFeePerGas,
    maxPriorityFeePerGas: maxPriorityFeePerGas,
  });

  logTxHashLink(swapTx.hash, hre);

  const swapTxReceipt = await swapTx.wait();
  if (swapTxReceipt.status !== 1) {
    console.log("swapTxReceipt", swapTxReceipt);
    throw new Error("Swap failed!");
  }

  const logs = swapTxReceipt.logs;
  // set up interface to parse the logs
  const erc20Interface = new ethers.utils.Interface(ERC20_ABI);
  // looking for the "Transfer" event
  const transferEventSignatureHash = erc20Interface.getEventTopic("Transfer");
  const tokenOutLog = logs.find((log) => {
    if (
      log.topics &&
      // first topic is always reserved for the event signature hash
      log.topics[0] === transferEventSignatureHash &&
      // only looking for the event log associated with tokenOut.address
      log.address.toLowerCase() === (tokenOut as Token).address.toLowerCase()
    ) {
      const parsedLog = erc20Interface.parseLog(log);
      // only looking for the event log where the "to" address is the recipient of the swap
      return parsedLog.args.to === signer.address;
    }
    return false;
  });

  let tokenOutAmount = "?";
  if (tokenOutLog) {
    const parsedLog = erc20Interface.parseLog(tokenOutLog);
    const rawTokenOutAmount = parsedLog.args.value;
    tokenOutAmount = ethers.utils.formatUnits(
      rawTokenOutAmount,
      tokenOut.decimals
    );
  }

  const gasSpentInUSD = await getGasSpentInUSD(swapTxReceipt, hre);

  console.log(
    chalk.green(
      `Swapped ${amountIn} ${tokenIn.symbol} for ${tokenOutAmount} ${tokenOut.symbol} using ${gasSpentInUSD} worth of gas`
    )
  );
}
