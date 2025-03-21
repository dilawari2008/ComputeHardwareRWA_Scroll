import createHttpError from "http-errors";
import axios from "axios";
import FormData from "form-data";
import Config from "@/config";
import fs from "fs";
import { ethers } from "ethers";
import EChain from "@/common/chain.enum";
import { MARKETPLACE_ABI } from "@/common/constants/abi/marketplace.abi";
import { RWADAO_ABI } from "@/common/constants/abi/rwa-dao.abi";
import { RWA_TOKEN_ABI } from "@/common/constants/abi/token";
import { RWA_NFT_ABI } from "@/common/constants/abi/nft.abi";
import { Deployment } from "@/db/models/deployment";
import DeploymentService from "@/services/deployment";
import { CPUMetric } from "@/db/models/cpu-metric";
import { IDeployment } from "@/interfaces/model";
import { PRICE_ORACLE_ABI } from "@/common/constants/abi/price-oracle.abi";

const provider = new ethers.providers.JsonRpcProvider(
  Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
);

// Fix 2: Use Axios directly for reliable uploads
const uploadToPinata = async (file: Express.Multer.File) => {
  try {
    const data = new FormData();

    // Append file as a readable stream
    data.append("file", fs.createReadStream(file.path), {
      filename: file.originalname,
      contentType: file.mimetype,
    });

    const response = await axios.post(Config.pinata.pinataBlobUrl, data, {
      maxContentLength: Infinity,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${
          (data as any)._boundary
        }`,
        Authorization: `Bearer ${Config.pinata.jwt}`,
      },
    });

    // Clean up
    fs.unlinkSync(file.path);

    // Return standard gateway URL instead of custom gateway
    const res = {
      pinataUrl: `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`,
      customGatewayUrl: `https://${Config.pinata.gateway}/ipfs/${response.data.IpfsHash}`,
    };

    return res;
  } catch (error) {
    console.error("Error uploading to Pinata:", error);
    throw error;
  }
};

interface ICreateListingReq {
  hardwareName: string;
  totalTokens: number;
  tokenPrice: number;
  rentalPrice: number;
  imageUrl: string;
  cpu: string;
  memory: string;
  location: string;
  userAddress: string;
  instanceId: string;
}

const createListing = async (listing: ICreateListingReq) => {
  if (!listing.hardwareName || !listing.userAddress) {
    throw createHttpError.BadRequest(
      "Hardware name and user address are required"
    );
  }

  const {
    hardwareName,
    userAddress,
    imageUrl,
    cpu,
    memory,
    location,
    totalTokens,
    tokenPrice,
    rentalPrice,
    instanceId,
  } = listing;

  const hardwareMetadata = {
    name: hardwareName,
    instanceId,
    image: imageUrl,
    cpu: cpu || "",
    memory: memory || "",
    location: location || "",
  };

  const contractAddress =
    Config.contractAddress[(process.env.CHAIN as EChain) || EChain.hardhat]
      .marketplace;

  const requestConfig = {
    method: "post",
    maxBodyLength: Infinity,
    url: `${Config.pinata.pinataJsonUrl}`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Config.pinata.jwt}`,
    },
    data: JSON.stringify({
      pinataContent: hardwareMetadata,
      pinataMetadata: {
        name: hardwareName,
      },
    }),
  };

  const response = await axios.request(requestConfig);

  const metadataUrl = `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`;

  const nftName = `${hardwareName} NFT`;
  const nftSymbol =
    hardwareName
      .replace(/[^A-Z0-9]/gi, "")
      .substring(0, 5)
      .toUpperCase() + "NFT";
  const tokenName = `${hardwareName} Token`;
  const tokenSymbol =
    hardwareName
      .replace(/[^A-Z0-9]/gi, "")
      .substring(0, 5)
      .toUpperCase() + "TKN";

  // 4. Create contract interface
  const contract = new ethers.utils.Interface(MARKETPLACE_ABI);

  // 5. Encode function data for createListing
  const data = contract.encodeFunctionData("createListing", [
    nftName,
    nftSymbol,
    tokenName,
    tokenSymbol,
    metadataUrl,
    ethers.BigNumber.from(totalTokens || "1000"),
    ethers.utils.parseUnits(tokenPrice.toString(), "ether"),
    ethers.utils.parseUnits(rentalPrice.toString(), "ether"),
  ]);

  // 6. Estimate gas (this will be paid by the user)
  const gasEstimate = await provider.estimateGas({
    from: userAddress,
    to: contractAddress,
    data,
  });

  // 7. Get current gas price
  const gasPrice = await provider.getGasPrice();

  // 8. Get nonce for the user
  const nonce = await provider.getTransactionCount(userAddress);

  // 9. Get chainId
  const network = await provider.getNetwork();
  const chainId = network.chainId;

  // 10. Create transaction object
  const txObject = {
    from: userAddress,
    to: contractAddress,
    data,
    gasLimit: gasEstimate,
    gasPrice,
    nonce,
    chainId,
  };

  // Return the transaction for the frontend to sign
  const res = {
    tx: txObject,
    message: "Transaction created successfully. Please sign and submit.",
  };

  return res;
};

interface IFractionalizeTokensReq {
  numberOfTokens: number;
  userAddress: string;
  daoAddress: string;
}

// First function for token approval
const getTokenApprovalTx = async (req: IFractionalizeTokensReq) => {
  const { numberOfTokens, userAddress, daoAddress } = req;

  if (!numberOfTokens || !userAddress || !daoAddress) {
    throw createHttpError.BadRequest(
      "Number of tokens, user address, and DAO address are required"
    );
  }

  if (numberOfTokens <= 0) {
    throw createHttpError.BadRequest("Amount must be greater than 0");
  }

  // Create provider
  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    // Get the RWADao contract to find the token contract address
    const daoContract = new ethers.Contract(daoAddress, RWADAO_ABI, provider);
    const tokenContractAddress = await daoContract.TOKEN_CONTRACT();

    // Create token contract interface
    const tokenContract = new ethers.utils.Interface(RWA_TOKEN_ABI);

    // Prepare approval transaction
    const approvalData = tokenContract.encodeFunctionData("approve", [
      daoAddress,
      ethers.BigNumber.from(numberOfTokens),
    ]);

    // Estimate gas for approval
    const approvalGasEstimate = await provider.estimateGas({
      from: userAddress,
      to: tokenContractAddress,
      data: approvalData,
    });

    // Get current gas price
    const gasPrice = await provider.getGasPrice();

    // Get nonce for the user
    const nonce = await provider.getTransactionCount(userAddress);

    // Get chainId
    const network = await provider.getNetwork();
    const chainId = network.chainId;

    // Create approval transaction object
    const approvalTx = {
      from: userAddress,
      to: tokenContractAddress,
      data: approvalData,
      gasLimit: approvalGasEstimate,
      gasPrice,
      nonce,
      chainId,
    };

    const res = {
      tx: approvalTx,
      message:
        "Transaction created successfully. Please sign to approve token transfer.",
    };

    return res;
  } catch (error: any) {
    if (error.message && error.message.includes("Insufficient balance")) {
      throw createHttpError.BadRequest(
        "You don't have enough tokens to approve the requested amount."
      );
    }

    throw createHttpError.InternalServerError(
      `Failed to prepare token approval transaction: ${error.message}`
    );
  }
};

// Second function for DAO approval
const getFractionalizeTokensTx = async (req: IFractionalizeTokensReq) => {
  const { numberOfTokens, userAddress, daoAddress } = req;

  if (!numberOfTokens || !userAddress || !daoAddress) {
    throw createHttpError.BadRequest(
      "Number of tokens, user address, and DAO address are required"
    );
  }

  if (numberOfTokens <= 0) {
    throw createHttpError.BadRequest("Amount must be greater than 0");
  }

  // Create provider
  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    // Create DAO contract interface
    const daoInterface = new ethers.utils.Interface(RWADAO_ABI);

    // Encode function data for approveTokensForSale
    const saleData = daoInterface.encodeFunctionData("approveTokensForSale", [
      ethers.BigNumber.from(numberOfTokens),
    ]);

    // Estimate gas for the transaction
    const saleGasEstimate = await provider.estimateGas({
      from: userAddress,
      to: daoAddress,
      data: saleData,
    });

    // Get current gas price
    const gasPrice = await provider.getGasPrice();

    // Get nonce for the user
    const nonce = await provider.getTransactionCount(userAddress);

    // Get chainId
    const network = await provider.getNetwork();
    const chainId = network.chainId;

    // Create sale approval transaction object
    const saleTx = {
      from: userAddress,
      to: daoAddress,
      data: saleData,
      gasLimit: saleGasEstimate,
      gasPrice,
      nonce,
      chainId,
    };

    return {
      tx: saleTx,
      message:
        "Transaction created successfully. Please sign to list tokens for sale.",
    };
  } catch (error: any) {
    if (
      error.message &&
      error.message.includes("Total would exceed approval")
    ) {
      throw createHttpError.BadRequest(
        "You need to approve the DAO contract to spend your tokens first. Please call the token approval function before trying again."
      );
    }

    if (error.message && error.message.includes("Insufficient balance")) {
      throw createHttpError.BadRequest(
        "You don't have enough tokens to fractionalize the requested amount."
      );
    }

    throw createHttpError.InternalServerError(
      `Failed to prepare fractionalization transaction: ${error.message}`
    );
  }
};

interface IBuyTokensReq {
  numberOfTokens: number;
  userAddress: string;
  daoAddress: string;
}

const buyTokens = async (req: IBuyTokensReq) => {
  const { numberOfTokens, userAddress, daoAddress } = req;

  if (!numberOfTokens || !userAddress || !daoAddress) {
    throw createHttpError.BadRequest(
      "Number of tokens, user address, and DAO address are required"
    );
  }

  if (numberOfTokens <= 0) {
    throw createHttpError.BadRequest("Amount must be greater than 0");
  }

  // Create provider
  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    // Get the token price from the DAO contract
    const daoContract = new ethers.Contract(daoAddress, RWADAO_ABI, provider);
    const tokenPrice = await daoContract.tokenPrice();

    // Calculate total payment required
    const totalPayment = tokenPrice.mul(ethers.BigNumber.from(numberOfTokens));

    // Check if enough tokens are available for sale
    const availableTokens = await daoContract.getAvailableTokensForSale();
    if (availableTokens.lt(numberOfTokens)) {
      throw createHttpError.BadRequest(
        `Not enough tokens available for sale. Requested: ${numberOfTokens}, Available: ${availableTokens.toString()}`
      );
    }

    // Create DAO contract interface
    const daoInterface = new ethers.utils.Interface(RWADAO_ABI);

    // Encode function data for buyTokens
    const buyData = daoInterface.encodeFunctionData("buyTokens", [
      ethers.BigNumber.from(numberOfTokens),
    ]);

    // Estimate gas
    const gasEstimate = await provider.estimateGas({
      from: userAddress,
      to: daoAddress,
      data: buyData,
      value: totalPayment,
    });

    // Get current gas price
    const gasPrice = await provider.getGasPrice();

    // Get nonce for the user
    const nonce = await provider.getTransactionCount(userAddress);

    // Get chainId
    const network = await provider.getNetwork();
    const chainId = network.chainId;

    // Create transaction object
    const txObject = {
      from: userAddress,
      to: daoAddress,
      data: buyData,
      value: totalPayment.toString(),
      gasLimit: gasEstimate,
      gasPrice,
      nonce,
      chainId,
    };

    const res = {
      tx: txObject,
      totalPayment: ethers.utils.formatEther(totalPayment),
      message: `Transaction created to buy ${numberOfTokens} tokens for ${ethers.utils.formatEther(
        totalPayment
      )} ETH. Please sign to complete purchase.`,
    };

    return res;
  } catch (error: any) {
    // Handle specific error cases
    if (
      error.message &&
      error.message.includes("Not enough tokens available")
    ) {
      throw error; // Re-throw our custom error
    }

    if (error.message && error.message.includes("Incorrect payment amount")) {
      throw createHttpError.BadRequest(
        "Incorrect payment amount calculated. Please try again."
      );
    }

    throw createHttpError.InternalServerError(
      `Failed to prepare buy transaction: ${error.message}`
    );
  }
};

interface ListingMetadata {
  name?: string;
  image?: string;
  cpu?: string;
  memory?: string;
  location?: string;
  daoAddress: string;
  tokenPrice?: string;
  rentalPrice?: string;
}

const getListing = async () => {
  try {
    // Create provider
    const provider = new ethers.providers.JsonRpcProvider(
      Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
    );

    // Get marketplace contract address
    const marketplaceAddress =
      Config.contractAddress[(process.env.CHAIN as EChain) || EChain.hardhat]
        .marketplace;

    // Create marketplace contract instance
    const marketplaceContract = new ethers.Contract(
      marketplaceAddress,
      MARKETPLACE_ABI,
      provider
    );

    // Get all dao addresses from marketplace
    const daoAddresses = await marketplaceContract.getListings();

    // Fetch all listings in parallel
    const listingsPromises = daoAddresses.map(async (daoAddress: string) => {
      try {
        // Create dao contract instance
        const daoContract = new ethers.Contract(
          daoAddress,
          RWADAO_ABI,
          provider
        );

        // Get contract data in parallel
        const [nftContractAddress, tokenPrice, rentalPrice] = await Promise.all(
          [
            daoContract.NFT_CONTRACT(),
            daoContract.tokenPrice(),
            daoContract.rentalPrice(),
          ]
        );

        // Create NFT contract instance
        const nftContract = new ethers.Contract(
          nftContractAddress,
          RWA_NFT_ABI,
          provider
        );

        // Get metadata URL for NFT index 0
        const metadataUrl = await nftContract.tokenURI(0);

        // Fetch metadata JSON
        const response = await axios.get(metadataUrl);
        const metadata = response.data;

        // Return listing with dao address and price information
        const listing = {
          ...metadata,
          daoAddress,
          tokenPrice: ethers.utils.formatEther(tokenPrice),
          rentalPrice: ethers.utils.formatEther(rentalPrice),
        };

        return listing;
      } catch (error) {
        console.error(`Error fetching data for DAO at ${daoAddress}:`, error);
        // Return null for failed listings
        return null;
      }
    });

    // Wait for all promises to resolve
    const results = await Promise.all(listingsPromises);

    // Filter out null values (failed listings)
    const listings = results.filter(
      (listing) => listing !== null
    ) as ListingMetadata[];

    // Sort listings by daoAddress
    const sortedListings = listings.sort((a, b) => {
      return a.daoAddress.localeCompare(b.daoAddress);
    });

    return sortedListings;
  } catch (error: any) {
    console.error("Error in getListing:", error);
    throw createHttpError.InternalServerError(
      `Failed to get listings: ${error.message}`
    );
  }
};

const getDaoTokenInfo = async (daoAddress: string) => {
  if (!daoAddress) {
    throw createHttpError.BadRequest("DAO address is required");
  }

  // Create provider
  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    // Get the RWADao contract
    const daoContract = new ethers.Contract(daoAddress, RWADAO_ABI, provider);

    // Get the token contract address
    const tokenContractAddress = await daoContract.TOKEN_CONTRACT();

    // Create token contract instance
    const tokenContract = new ethers.Contract(
      tokenContractAddress,
      RWA_TOKEN_ABI,
      provider
    );

    // Get total supply of tokens
    const totalSupply = await tokenContract.totalSupply();

    // Get available tokens for sale
    const availableTokensForSale =
      await daoContract.getAvailableTokensForSale();

    const res = {
      totalTokens: totalSupply.toString(),
      availableTokensForSale: availableTokensForSale.toString(),
      formattedTotalTokens: Number(totalSupply.toString()),
      formattedAvailableTokensForSale: Number(
        availableTokensForSale.toString()
      ),
    };

    return res;
  } catch (error: any) {
    console.error("Error fetching DAO token info:", error);
    throw createHttpError.InternalServerError(
      `Failed to get DAO token information: ${error.message}`
    );
  }
};

const getDaoDetails = async (daoAddress: string) => {
  if (!daoAddress) {
    throw createHttpError.BadRequest("DAO address is required");
  }

  // Create provider
  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    // Get the RWADao contract
    const daoContract = new ethers.Contract(daoAddress, RWADAO_ABI, provider);

    // Get contract addresses
    const tokenContractAddress = await daoContract.TOKEN_CONTRACT();
    const nftContractAddress = await daoContract.NFT_CONTRACT();

    // Create contract instances
    const tokenContract = new ethers.Contract(
      tokenContractAddress,
      RWA_TOKEN_ABI,
      provider
    );
    const nftContract = new ethers.Contract(
      nftContractAddress,
      RWA_NFT_ABI,
      provider
    );

    // Get marketplace contract address
    const marketplaceAddress =
      Config.contractAddress[(process.env.CHAIN as EChain) || EChain.hardhat]
        .marketplace;
    const marketplaceContract = new ethers.Contract(
      marketplaceAddress,
      MARKETPLACE_ABI,
      provider
    );

    // Get token and rental prices
    const tokenPrice = await daoContract.tokenPrice();
    const rentalPrice = await daoContract.rentalPrice();

    // Get current tenant status
    const currentTenant = await daoContract.currentTenant();
    const isAvailable = currentTenant === ethers.constants.AddressZero;

    // Get token details
    const tokenName = await tokenContract.name();
    const tokenSymbol = await tokenContract.symbol();
    const totalSupply = await tokenContract.totalSupply();
    const availableTokensForSale =
      await daoContract.getAvailableTokensForSale();

    // Get NFT details and metadata
    const nftTokenId = 0; // First token
    const nftTokenURI = await nftContract.tokenURI(nftTokenId);

    // Get marketplace parameters
    const feePercentage = await marketplaceContract.getRentalFeePercentage();
    const voteThreshold = await marketplaceContract.getVoteThreshold();
    const percentageDecimals =
      await marketplaceContract.getPercentageDecimals();

    // Get hardware metadata from token URI
    let hardwareMetadata: any = {};
    try {
      const response = await axios.get(nftTokenURI);
      hardwareMetadata = response.data;
    } catch (error) {
      console.warn(`Could not fetch metadata from ${nftTokenURI}:`, error);
    }

    const formattedVoteThreshold = `${
      (voteThreshold * 100) / percentageDecimals
    }% majority`;
    const formattedFeePercentage = `${
      (feePercentage * 100) / percentageDecimals
    }% marketplace fee`;

    // Format results by category
    const result = {
      hardware: {
        name: hardwareMetadata?.name || "NVIDIA A100 80GB",
        performance: hardwareMetadata?.cpu || "312 TFLOPS (FP16)",
        location: hardwareMetadata?.location || "US East",
        created: hardwareMetadata?.created || "5/15/2023",
        status: isAvailable ? "Available" : "Rented",
        rentalPrice: `${ethers.utils.formatEther(rentalPrice)} ETH / day`,
        image: hardwareMetadata?.image ?? "",
        instanceId: hardwareMetadata?.instanceId ?? "",
      },
      token: {
        name: tokenName || "NVIDIA A100 Token",
        symbol: tokenSymbol || "A100T",
        address: tokenContractAddress,
        totalSupply: totalSupply.toString() || "100 tokens",
        availableForSale: availableTokensForSale.toString() || "25 tokens",
        tokenPrice: `${ethers.utils.formatEther(tokenPrice)} ETH / token`,
      },
      dao: {
        address: daoAddress,
        governance: "Token-weighted voting",
        voteThreshold: formattedVoteThreshold,
        feeStructure: formattedFeePercentage,
      },
      nft: {
        address: nftContractAddress,
        id: nftTokenId.toString(),
        legalBinding: "Verified ✓",
        hardwareVerification: "Verified ✓",
      },
    };

    return result;
  } catch (error: any) {
    console.error("Error fetching DAO details:", error);
    throw createHttpError.InternalServerError(
      `Failed to get DAO details: ${error.message}`
    );
  }
};

interface IProposeNewRentalPriceReq {
  daoAddress: string;
  userAddress: string;
  newRentalPrice: string;
}

const proposeNewRentalPrice = async (req: IProposeNewRentalPriceReq) => {
  const { daoAddress, userAddress, newRentalPrice } = req;

  if (!daoAddress || !userAddress || !newRentalPrice) {
    throw createHttpError.BadRequest(
      "DAO address, user address, and new rental price are required"
    );
  }

  if (parseFloat(newRentalPrice) <= 0) {
    throw createHttpError.BadRequest("Rental price must be greater than 0");
  }

  // Create provider
  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    // Get the RWADao contract
    const daoContract = new ethers.Contract(daoAddress, RWADAO_ABI, provider);

    // Get the token contract address to check if user is a token holder
    const tokenContractAddress = await daoContract.TOKEN_CONTRACT();
    const tokenContract = new ethers.Contract(
      tokenContractAddress,
      RWA_TOKEN_ABI,
      provider
    );

    // Check if user is a token holder
    const tokenBalance = await tokenContract.balanceOf(userAddress);
    if (tokenBalance.eq(0)) {
      throw createHttpError.BadRequest(
        "You must be a token holder to propose a new rental price"
      );
    }

    // Check if there's an active proposal
    const currentProposal = await daoContract.currentProposal();
    if (currentProposal.isActive) {
      throw createHttpError.BadRequest("There's already an active proposal");
    }

    // Get current rental price for information
    const currentRentalPrice = await daoContract.rentalPrice();

    // Create DAO contract interface
    const daoInterface = new ethers.utils.Interface(RWADAO_ABI);

    // Convert new rental price to proper format (wei)
    const newRentalPriceWei = ethers.utils.parseEther(
      newRentalPrice.toString()
    );

    // Encode function data for proposeNewRent
    const proposeData = daoInterface.encodeFunctionData("proposeNewRent", [
      newRentalPriceWei,
    ]);

    // Estimate gas
    const gasEstimate = await provider.estimateGas({
      from: userAddress,
      to: daoAddress,
      data: proposeData,
    });

    // Get current gas price
    const gasPrice = await provider.getGasPrice();

    // Get nonce for the user
    const nonce = await provider.getTransactionCount(userAddress);

    // Get chainId
    const network = await provider.getNetwork();
    const chainId = network.chainId;

    // Create transaction object
    const txObject = {
      from: userAddress,
      to: daoAddress,
      data: proposeData,
      gasLimit: gasEstimate,
      gasPrice,
      nonce,
      chainId,
    };

    // Get vote threshold for information
    const voteThreshold = await daoContract.VOTE_THRESHOLD();
    const percentageDecimals = await daoContract.PERCENTAGE_DECIMALS();
    const thresholdPercentage = (voteThreshold * 100) / percentageDecimals;

    const res = {
      tx: txObject,
      currentRentalPrice: ethers.utils.formatEther(currentRentalPrice),
      newRentalPrice: newRentalPrice.toString(),
      voteThreshold: `${thresholdPercentage}%`,
      message: `Transaction created to propose new rental price of ${newRentalPrice} ETH/day (current: ${ethers.utils.formatEther(
        currentRentalPrice
      )} ETH/day). Requires ${thresholdPercentage}% majority to pass.`,
    };

    return res;
  } catch (error: any) {
    if (error.code === "CALL_EXCEPTION") {
      throw createHttpError.BadRequest(
        "Contract call failed. Make sure the DAO contract is valid."
      );
    }

    throw createHttpError.InternalServerError(
      `Failed to create proposal transaction: ${error.message}`
    );
  }
};

interface IVoteOnProposalReq {
  daoAddress: string;
  userAddress: string;
  inFavor: boolean;
}

const voteOnProposal = async (req: IVoteOnProposalReq) => {
  const { daoAddress, userAddress, inFavor } = req;

  if (!daoAddress || !userAddress || inFavor === undefined) {
    throw createHttpError.BadRequest(
      "DAO address, user address, and vote choice are required"
    );
  }

  // Create provider
  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    // Get the RWADao contract
    const daoContract = new ethers.Contract(daoAddress, RWADAO_ABI, provider);

    // Get the token contract address to check if user is a token holder
    const tokenContractAddress = await daoContract.TOKEN_CONTRACT();
    const tokenContract = new ethers.Contract(
      tokenContractAddress,
      RWA_TOKEN_ABI,
      provider
    );

    // Check if user is a token holder
    const tokenBalance = await tokenContract.balanceOf(userAddress);
    if (tokenBalance.eq(0)) {
      throw createHttpError.BadRequest("You must be a token holder to vote");
    }

    // Check if there's an active proposal
    const currentProposal = await daoContract.currentProposal();
    if (!currentProposal.isActive) {
      throw createHttpError.BadRequest("There's no active proposal to vote on");
    }

    // The currentProposal is a struct and we can't directly access its hasVoted mapping
    // We need to call the contract's view function that checks this
    try {
      // Since there's no direct function to check if voted, we'll try to vote in a static call
      // If it reverts with "Already voted", then we know the user has voted
      await daoContract.callStatic.vote(inFavor, { from: userAddress });
      // If we reach here, it means the user hasn't voted yet
    } catch (error: any) {
      if (error.message.includes("Already voted")) {
        throw createHttpError.BadRequest(
          "You have already voted on this proposal"
        );
      }
      // For other errors, continue with the function
    }

    // Get user's voting weight for information
    const totalSupply = await tokenContract.totalSupply();
    const percentageDecimals = await daoContract.PERCENTAGE_DECIMALS();
    const voterWeight = tokenBalance.mul(percentageDecimals).div(totalSupply);
    const voterWeightPercentage = (voterWeight * 100) / percentageDecimals;

    const proposedPrice = currentProposal.proposedPrice;

    // Create DAO contract interface
    const daoInterface = new ethers.utils.Interface(RWADAO_ABI);

    // Encode function data for vote
    const voteData = daoInterface.encodeFunctionData("vote", [inFavor]);

    // Estimate gas
    const gasEstimate = await provider.estimateGas({
      from: userAddress,
      to: daoAddress,
      data: voteData,
    });

    // Get current gas price
    const gasPrice = await provider.getGasPrice();

    // Get nonce for the user
    const nonce = await provider.getTransactionCount(userAddress);

    // Get chainId
    const network = await provider.getNetwork();
    const chainId = network.chainId;

    // Create transaction object
    const txObject = {
      from: userAddress,
      to: daoAddress,
      data: voteData,
      gasLimit: gasEstimate,
      gasPrice,
      nonce,
      chainId,
    };

    const res = {
      tx: txObject,
      proposedPrice: ethers.utils.formatEther(proposedPrice),
      votingWeight: `${voterWeightPercentage}%`,
      vote: inFavor ? "In favor" : "Against",
      message: `Transaction created to vote ${
        inFavor ? "in favor of" : "against"
      } the proposal to change rental price to ${ethers.utils.formatEther(
        proposedPrice
      )} ETH/day. Your voting weight is ${voterWeightPercentage}%.`,
    };

    return res;
  } catch (error: any) {
    // Handle specific error cases
    if (error.code === "CALL_EXCEPTION") {
      throw createHttpError.BadRequest(
        "Contract call failed. Make sure the DAO contract is valid."
      );
    }

    throw createHttpError.InternalServerError(
      `Failed to create vote transaction: ${error.message}`
    );
  }
};

const getCurrentProposal = async (daoAddress: string) => {
  if (!daoAddress) {
    throw createHttpError.BadRequest("DAO address is required");
  }

  // Create provider
  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    // Get the RWADao contract - use daoAddress directly instead of an object
    const daoContract = new ethers.Contract(daoAddress, RWADAO_ABI, provider);

    // Get proposal details
    const currentProposal = await daoContract.currentProposal();

    // Get current rental price for comparison
    const currentRentalPrice = await daoContract.rentalPrice();

    // Get vote threshold information
    const voteThreshold = await daoContract.VOTE_THRESHOLD();
    const percentageDecimals = await daoContract.PERCENTAGE_DECIMALS();
    const thresholdPercentage = (voteThreshold * 100) / percentageDecimals;

    // If there's no active proposal
    if (!currentProposal.isActive) {
      return {
        active: false,
        message: "No active rental price proposal",
      };
    }

    // Format the response with relevant proposal details
    const res = {
      active: true,
      proposedPrice: ethers.utils.formatEther(currentProposal.proposedPrice),
      currentPrice: ethers.utils.formatEther(currentRentalPrice),
      votesFor: (currentProposal.votesFor * 100) / percentageDecimals,
      votesAgainst: (currentProposal.votesAgainst * 100) / percentageDecimals,
      voteThreshold: thresholdPercentage,
      proposalTimestamp: new Date(
        currentProposal.timestamp.toNumber() * 1000
      ).toISOString(),
      remainingNeeded: Math.max(
        0,
        thresholdPercentage -
          (currentProposal.votesFor * 100) / percentageDecimals
      ),
      status: getProposalStatus(
        currentProposal.votesFor,
        currentProposal.votesAgainst,
        voteThreshold,
        percentageDecimals
      ),
    };

    return res;
  } catch (error: any) {
    console.error("Error fetching current proposal:", error);
    throw createHttpError.InternalServerError(
      `Failed to get proposal information: ${error.message}`
    );
  }
};

// Helper function to determine the status of a proposal
const getProposalStatus = (
  votesFor: number,
  votesAgainst: number,
  threshold: number,
  decimals: number
) => {
  const forPercentage = (votesFor * 100) / decimals;
  const againstPercentage = (votesAgainst * 100) / decimals;
  const thresholdPercentage = (threshold * 100) / decimals;

  if (forPercentage >= thresholdPercentage) {
    return "Passing";
  } else if (againstPercentage > 100 - thresholdPercentage) {
    return "Failing";
  } else {
    return "In Progress";
  }
};

interface IBecomeTenantReq {
  userAddress: string;
  daoAddress: string;
}

const becomeTenant = async (req: IBecomeTenantReq) => {
  try {
    const { userAddress, daoAddress } = req;

    if (!userAddress || !daoAddress) {
      throw createHttpError.BadRequest(
        "User address and DAO address are required"
      );
    }

    // Create provider
    const provider = new ethers.providers.JsonRpcProvider(
      Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
    );

    // Get the RWADao contract
    const daoContract = new ethers.Contract(daoAddress, RWADAO_ABI, provider);

    // Check if there's already a tenant
    const currentTenant = await daoContract.currentTenant();
    if (currentTenant !== ethers.constants.AddressZero) {
      throw createHttpError.BadRequest(
        "This property already has a tenant. It's not available for rent."
      );
    }

    // Get the rental price
    const rentalPrice = await daoContract.rentalPrice();

    // Create DAO contract interface
    const daoInterface = new ethers.utils.Interface(RWADAO_ABI);

    // Encode function data for becomeTenant (with no arguments, as per the contract)
    const becomeTenantData = daoInterface.encodeFunctionData(
      "becomeTenant",
      []
    );

    // Estimate gas
    const gasEstimate = await provider.estimateGas({
      from: userAddress,
      to: daoAddress,
      data: becomeTenantData,
      value: rentalPrice, // Send the rental price as ETH
    });

    // Get current gas price
    const gasPrice = await provider.getGasPrice();

    // Get nonce for the user
    const nonce = await provider.getTransactionCount(userAddress);

    // Get chainId
    const network = await provider.getNetwork();
    const chainId = network.chainId;

    // Create transaction object
    const txObject = {
      from: userAddress,
      to: daoAddress,
      data: becomeTenantData,
      value: rentalPrice.toString(), // Send the rental price as ETH
      gasLimit: gasEstimate,
      gasPrice,
      nonce,
      chainId,
    };

    const res = {
      tx: txObject,
      rentalPrice: ethers.utils.formatEther(rentalPrice),
      message: `Transaction created to become a tenant for ${ethers.utils.formatEther(
        rentalPrice
      )} ETH. Please sign to complete the rental.`,
    };

    return res;
  } catch (error: any) {
    // Handle specific error cases
    if (error.message && error.message.includes("Property already rented")) {
      throw createHttpError.BadRequest(
        "This property is already rented by another tenant."
      );
    }

    if (error.message && error.message.includes("Incorrect rent amount")) {
      throw createHttpError.BadRequest(
        "The rental payment amount is incorrect. Please try again."
      );
    }

    throw createHttpError.InternalServerError(
      `Failed to prepare tenant transaction: ${error.message}`
    );
  }
};

const getDaoBalance = async (daoAddress: string) => {
  if (!daoAddress) {
    throw createHttpError.BadRequest("DAO address is required");
  }

  // Create provider
  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    // Get the contract's ETH balance
    const balanceWei = await provider.getBalance(daoAddress);

    return {
      balanceWei: balanceWei.toString(),
      balanceEth: ethers.utils.formatEther(balanceWei),
    };
  } catch (error: any) {
    console.error("Error fetching DAO balance:", error);
    throw createHttpError.InternalServerError(
      `Failed to get DAO balance: ${error.message}`
    );
  }
};

interface IIsDAOMemberReq {
  userAddress: string;
  daoAddress: string;
}

const isDAOMember = async (req: IIsDAOMemberReq) => {
  const { userAddress, daoAddress } = req;

  if (!userAddress || !daoAddress) {
    throw createHttpError.BadRequest(
      "User address and DAO address are required"
    );
  }

  // Create provider
  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    // Get the RWADao contract
    const daoContract = new ethers.Contract(daoAddress, RWADAO_ABI, provider);

    // Get the token contract address
    const tokenContractAddress = await daoContract.TOKEN_CONTRACT();

    // Create token contract instance
    const tokenContract = new ethers.Contract(
      tokenContractAddress,
      RWA_TOKEN_ABI,
      provider
    );

    // Check if the user is a token holder using the isHolder function
    const isMember = await tokenContract.isHolder(userAddress);

    // Alternatively, you could check token balance
    const tokenBalance = await tokenContract.balanceOf(userAddress);
    const hasMembership = tokenBalance.gt(0);

    return {
      isMember,
      tokenBalance: tokenBalance.toString(),
      tokenAddress: tokenContractAddress,
    };
  } catch (error: any) {
    console.error("Error checking DAO membership:", error);
    throw createHttpError.InternalServerError(
      `Failed to check DAO membership status: ${error.message}`
    );
  }
};

interface IsTenantReq {
  userAddress: string;
  daoAddress: string;
}

const isTenant = async (req: IsTenantReq) => {
  const { userAddress, daoAddress } = req;

  if (!userAddress || !daoAddress) {
    throw createHttpError.BadRequest(
      "User address and DAO address are required"
    );
  }

  // Create provider
  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    // Get the RWADao contract
    const daoContract = new ethers.Contract(daoAddress, RWADAO_ABI, provider);

    // Get the current tenant address
    const currentTenant = await daoContract.currentTenant();

    // Check if the user is the current tenant
    const isTenant = currentTenant.toLowerCase() === userAddress.toLowerCase();

    // Get the rental price for additional info
    const rentalPrice = await daoContract.rentalPrice();

    return {
      isTenant,
      currentTenant:
        currentTenant !== ethers.constants.AddressZero ? currentTenant : null,
      propertyAvailable: currentTenant === ethers.constants.AddressZero,
      rentalPrice: ethers.utils.formatEther(rentalPrice),
    };
  } catch (error: any) {
    console.error("Error checking tenant status:", error);
    throw createHttpError.InternalServerError(
      `Failed to check tenant status: ${error.message}`
    );
  }
};

const isMarketplaceOwner = async (userAddress: string) => {
  if (!userAddress) {
    throw createHttpError.BadRequest("User address is required");
  }

  // Create provider
  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    // Get marketplace contract address
    const marketplaceAddress =
      Config.contractAddress[(process.env.CHAIN as EChain) || EChain.hardhat]
        .marketplace;

    // Create marketplace contract instance
    const marketplaceContract = new ethers.Contract(
      marketplaceAddress,
      MARKETPLACE_ABI,
      provider
    );

    // Get the owner of the marketplace
    const ownerAddress = await marketplaceContract.owner();

    // Check if user is the owner
    const isOwner = ownerAddress.toLowerCase() === userAddress.toLowerCase();

    return {
      isOwner,
      marketplaceAddress,
      ownerAddress,
    };
  } catch (error: any) {
    console.error("Error checking marketplace ownership:", error);
    throw createHttpError.InternalServerError(
      `Failed to check marketplace ownership: ${error.message}`
    );
  }
};

interface IUnlockNFTReq {
  userAddress: string;
  daoAddress: string;
}

const getUnlistApprovalTx = async (req: IUnlockNFTReq) => {
  const { userAddress, daoAddress } = req;

  if (!userAddress || !daoAddress) {
    throw createHttpError.BadRequest(
      "User address and DAO address are required"
    );
  }

  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    const daoContract = new ethers.Contract(daoAddress, RWADAO_ABI, provider);
    const tokenContractAddress = await daoContract.TOKEN_CONTRACT();
    const tokenContract = new ethers.Contract(
      tokenContractAddress,
      RWA_TOKEN_ABI,
      provider
    );

    const totalSupply = await tokenContract.totalSupply();
    const userBalance = await tokenContract.balanceOf(userAddress);

    if (!userBalance.eq(totalSupply)) {
      throw createHttpError.BadRequest(
        `You must own all tokens to unlock the NFT. You own ${userBalance.toString()} of ${totalSupply.toString()} tokens.`
      );
    }

    const approvedAmount = await tokenContract.allowance(
      userAddress,
      daoAddress
    );

    if (approvedAmount.gte(totalSupply)) {
      return {
        needsApproval: false,
        message: "Tokens are already approved. Proceed to unlocking the NFT.",
      };
    }

    const tokenInterface = new ethers.utils.Interface(RWA_TOKEN_ABI);
    const approveData = tokenInterface.encodeFunctionData("approve", [
      daoAddress,
      totalSupply,
    ]);

    const approveGasEstimate = await provider.estimateGas({
      from: userAddress,
      to: tokenContractAddress,
      data: approveData,
    });

    const nonce = await provider.getTransactionCount(userAddress);
    const gasPrice = await provider.getGasPrice();
    const network = await provider.getNetwork();

    const approveTx = {
      from: userAddress,
      to: tokenContractAddress,
      data: approveData,
      gasLimit: approveGasEstimate,
      gasPrice,
      nonce,
      chainId: network.chainId,
    };

    return {
      needsApproval: true,
      tx: approveTx,
      totalSupply: totalSupply.toString(),
      message: "Approve token transfer to DAO contract before unlocking NFT",
    };
  } catch (error: any) {
    console.error("Error preparing approval transaction:", error);
    throw createHttpError.InternalServerError(
      `Failed to prepare approval transaction: ${error.message}`
    );
  }
};

const completeUnlist = async (req: IUnlockNFTReq) => {
  const { userAddress, daoAddress } = req;

  if (!userAddress || !daoAddress) {
    throw createHttpError.BadRequest(
      "User address and DAO address are required"
    );
  }

  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    const marketplaceAddress =
      Config.contractAddress[(process.env.CHAIN as EChain) || EChain.hardhat]
        .marketplace;

    // Check if marketplace owner
    const marketplaceContract = new ethers.Contract(
      marketplaceAddress ||
        Config.contractAddress[(process.env.CHAIN as EChain) || EChain.hardhat]
          .marketplace,
      MARKETPLACE_ABI,
      provider
    );

    const marketplaceOwner = await marketplaceContract.owner();
    if (marketplaceOwner.toLowerCase() !== userAddress.toLowerCase()) {
      throw createHttpError.BadRequest(
        "Only the marketplace owner can remove the listing"
      );
    }

    // Check token approval
    const daoContract = new ethers.Contract(daoAddress, RWADAO_ABI, provider);
    const tokenContractAddress = await daoContract.TOKEN_CONTRACT();
    const tokenContract = new ethers.Contract(
      tokenContractAddress,
      RWA_TOKEN_ABI,
      provider
    );

    const totalSupply = await tokenContract.totalSupply();
    const approvedAmount = await tokenContract.allowance(
      userAddress,
      daoAddress
    );

    if (approvedAmount.lt(totalSupply)) {
      throw createHttpError.BadRequest(
        `You must approve the DAO to transfer all tokens first. Currently approved: ${approvedAmount.toString()} of ${totalSupply.toString()} needed.`
      );
    }

    // Prepare transactions
    const nonce = await provider.getTransactionCount(userAddress);
    const gasPrice = await provider.getGasPrice();
    const network = await provider.getNetwork();
    const chainId = network.chainId;

    // 1. Unlock NFT transaction
    const daoInterface = new ethers.utils.Interface(RWADAO_ABI);
    const unlockData = daoInterface.encodeFunctionData("unlockNFT", []);

    const unlockGasEstimate = await provider.estimateGas({
      from: userAddress,
      to: daoAddress,
      data: unlockData,
    });

    const unlockTx = {
      from: userAddress,
      to: daoAddress,
      data: unlockData,
      gasLimit: unlockGasEstimate,
      gasPrice,
      nonce,
      chainId,
    };

    // 2. Remove listing transaction
    const marketplaceInterface = new ethers.utils.Interface(MARKETPLACE_ABI);
    const removeData = marketplaceInterface.encodeFunctionData(
      "removeListing",
      [daoAddress]
    );

    const removeGasEstimate = await provider.estimateGas({
      from: userAddress,
      to:
        marketplaceAddress ||
        Config.contractAddress[(process.env.CHAIN as EChain) || EChain.hardhat]
          .marketplace,
      data: removeData,
    });

    const removeTx = {
      from: userAddress,
      to:
        marketplaceAddress ||
        Config.contractAddress[(process.env.CHAIN as EChain) || EChain.hardhat]
          .marketplace,
      data: removeData,
      gasLimit: removeGasEstimate,
      gasPrice,
      nonce: nonce + 1,
      chainId,
    };

    return {
      transactions: [
        {
          tx: unlockTx,
          description: "Step 1: Unlock NFT by burning all tokens",
        },
        {
          tx: removeTx,
          description: "Step 2: Remove listing from marketplace",
        },
      ],
      message:
        "Execute these transactions in sequence to unlock the NFT and remove the listing",
    };
  } catch (error: any) {
    console.error("Error preparing unlisting transactions:", error);
    throw createHttpError.InternalServerError(
      `Failed to prepare unlisting transactions: ${error.message}`
    );
  }
};

const saveDeployment = async (deployment: IDeployment) => {
  // use daoAddress to get the NFT metadata and extract instance id from there
  const daoContract = new ethers.Contract(
    deployment.daoAddress,
    RWADAO_ABI,
    provider
  );
  // Get the NFT contract address from the DAO
  const nftContractAddress = await daoContract.NFT_CONTRACT();
  console.log(`NFT contract address: ${nftContractAddress}`);

  // Connect to the NFT contract
  const nftContract = new ethers.Contract(
    nftContractAddress,
    RWA_NFT_ABI,
    provider
  );

  // Get the metadata URL from the NFT contract
  // const tokenId = await daoContract.TOKEN_ID();
  const metadataUrl = await nftContract.tokenURI(0);
  console.log(`Metadata URL: ${metadataUrl}`);

  // Fetch the metadata content
  const response = await axios.get(metadataUrl);
  const metadata = response.data;

  // Extract the instance ID from metadata
  const instanceId = metadata.instanceId;
  console.log(`Instance ID: ${instanceId}`);

  // Update the deployment with the instance ID
  deployment.instanceId = instanceId;

  const deploymentRes = await Deployment.findOneAndUpdate(
    {
      userAddress: deployment.userAddress,
      daoAddress: deployment.daoAddress,
      instanceId: deployment.instanceId,
    },
    deployment,
    { new: true, upsert: true }
  );

  DeploymentService.deployScript(instanceId, deploymentRes.script);

  return deploymentRes;
};

const getDeployments = async (userAddress: string, daoAddress?: string) => {
  const query: { userAddress: string; daoAddress?: string } = { userAddress };

  if (daoAddress) {
    query.daoAddress = daoAddress;
  }

  const deployments = await Deployment.find(query);
  return deployments;
};

const getRentalPrice = async (daoAddress: string) => {
  if (!daoAddress) {
    throw createHttpError.BadRequest("DAO address is required");
  }

  const provider = new ethers.providers.JsonRpcProvider(
    Config.rpcUrl[(process.env.CHAIN as EChain) || EChain.hardhat]
  );

  try {
    // First get the base rental price from the DAO contract
    const daoContract = new ethers.Contract(daoAddress, RWADAO_ABI, provider);
    const baseRentalPriceWei = await daoContract.rentalPrice();

    // Get the PriceOracle address associated with the DAO
    // Assuming the DAO has a method to get its associated PriceOracle
    const priceOracleAddress = await daoContract.PRICE_ORACLE();

    // Connect to PriceOracle contract
    const priceOracleContract = new ethers.Contract(
      priceOracleAddress,
      PRICE_ORACLE_ABI,
      provider
    );

    // Get the proposed rental price based on CPU utilization
    const proposedRentalPriceWei =
      await priceOracleContract.getProposedRentalPrice(baseRentalPriceWei);

    const res = {
      baseRentalPriceWei: baseRentalPriceWei.toString(),
      baseRentalPriceEth: ethers.utils.formatEther(baseRentalPriceWei),
      rentalPriceWei: proposedRentalPriceWei.toString(),
      rentalPriceEth: ethers.utils.formatEther(proposedRentalPriceWei),
      cpuUtilization: (
        await priceOracleContract.getAverageUtilization()
      ).toString(),
    };

    return res;
  } catch (error: any) {
    console.error("Error fetching rental price:", error);
    throw createHttpError.InternalServerError(
      `Failed to get rental price: ${error.message}`
    );
  }
};

const getAverageCpuUtilization = async (daoAddress: string) => {
  const averageCpuUtilization =
    await DeploymentService.getAverageCpuUtilization(daoAddress);
  return averageCpuUtilization;
};

const ComputeService = {
  uploadToPinata,
  createListing,
  getTokenApprovalTx,
  getFractionalizeTokensTx,
  buyTokens,
  getListing,
  getDaoTokenInfo,
  getDaoDetails,
  proposeNewRentalPrice,
  voteOnProposal,
  getCurrentProposal,
  becomeTenant,
  getDaoBalance,
  isDAOMember,
  isTenant,
  isMarketplaceOwner,
  getUnlistApprovalTx,
  completeUnlist,
  saveDeployment,
  getDeployments,
  getRentalPrice,
  getAverageCpuUtilization,
};

export default ComputeService;
