import { expect } from 'chai';
import * as ethers from 'ethers';
import * as zksync from 'zksync';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const zksyncAbi = require('../../../../contracts/artifacts/cache/solpp-generated-contracts/ZkSync.sol/ZkSync.json').abi;
type Network = 'localhost' | 'rinkeby' | 'ropsten';

const testConfigPath = path.join(process.env.ZKSYNC_HOME as string, `etc/test_config/constant`);
const ethTestConfig = JSON.parse(fs.readFileSync(`${testConfigPath}/eth.json`, { encoding: 'utf-8' }));

export async function expectThrow(promise: Promise<any>, message: String) {
    let error = null;
    try {
        await promise;
    } catch (err) {
        error = err;
    }
    expect(error).to.be.an('Error');
    expect(error.message).to.include(message);
}

export class Tester {
    public contract: ethers.Contract;
    public runningFee: ethers.BigNumber;
    constructor(
        public network: Network,
        public ethProvider: ethers.providers.Provider,
        public syncProvider: zksync.SyncProvider,
        public ethWallet: ethers.Wallet,
        public syncWallet: zksync.Wallet
    ) {
        this.contract = new ethers.Contract(syncProvider.contractAddress.mainContract, zksyncAbi, ethWallet);
        this.runningFee = ethers.BigNumber.from(0);
    }

    // prettier-ignore
    static async init(network: Network, transport: 'WS' | 'HTTP', providerType: 'REST' | 'RPC') {
        if(transport === 'WS' && providerType === 'REST') {
            throw new Error('REST provider supports only HTTP transport');
        }
        // @ts-ignore
        let web3Url = process.env.ETH_CLIENT_WEB3_URL.split(",")[0];
        const ethProvider = network == 'localhost'
            ? new ethers.providers.JsonRpcProvider(web3Url)
            : ethers.getDefaultProvider(network);
        if (network == 'localhost') {
            ethProvider.pollingInterval = 100;
        }
        const syncProvider = providerType === 'REST' 
            ? await zksync.getDefaultRestProvider(network) 
            : await zksync.getDefaultProvider(network, transport);
        const ethWallet = new ethers.Wallet(Buffer.from(ethTestConfig.account_with_rbtc_cow_privK, 'hex'), ethProvider);
        
        const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
        return new Tester(network, ethProvider, syncProvider, ethWallet, syncWallet);
    }

    async disconnect() {
        await this.syncProvider.disconnect();
    }

    async fundedWallet(amount: string) {
        const randomWallet = ethers.Wallet.createRandom();
        const newWallet = new ethers.Wallet(randomWallet.privateKey, this.ethProvider);
        const syncWallet = await zksync.Wallet.fromEthSigner(newWallet, this.syncProvider);
        const handle = await this.ethWallet.sendTransaction({
            to: newWallet.address,
            value: ethers.utils.parseEther(amount)
        });
        await handle.wait();
        return syncWallet;
    }

    async emptyWallet() {
        const randomWallet = ethers.Wallet.createRandom();
        const ethWallet = new ethers.Wallet(randomWallet.privateKey, this.ethProvider);
        return await zksync.Wallet.fromEthSigner(ethWallet, this.syncProvider);
    }

    async operatorBalance(token: zksync.types.TokenLike) {
        const operatorAddress = process.env.CHAIN_STATE_KEEPER_FEE_ACCOUNT_ADDR as string;
        const accountState = await this.syncProvider.getState(operatorAddress);
        const tokenSymbol = this.syncProvider.tokenSet.resolveTokenSymbol(token);
        const balance = accountState.committed.balances[tokenSymbol] || '0';
        return ethers.BigNumber.from(balance);
    }

    async create2Wallet() {
        const signer = await zksync.Signer.fromSeed(crypto.randomBytes(32));
        const randomHex = (length: number) => {
            const bytes = crypto.randomBytes(length);
            return ethers.utils.hexlify(bytes);
        };
        const create2Data = {
            creatorAddress: randomHex(20),
            saltArg: randomHex(32),
            codeHash: randomHex(32)
        };
        return await zksync.Wallet.fromCreate2Data(signer, this.syncProvider, create2Data);
    }

    async submitToken(tokenAddress: string) {
        const govAbi = ['function tokenGovernance() public view returns (address)'];
        const gov = new ethers.Contract(this.syncProvider.contractAddress.govContract, govAbi, this.ethWallet);

        const tokenGovAddress = await gov.tokenGovernance();
        const tokenGovAbi = ['function addToken(address) external'];
        const tokenGov = new ethers.Contract(tokenGovAddress, tokenGovAbi, this.ethWallet);
        const tx = await tokenGov.addToken(tokenAddress);
        await tx.wait();
    }
}
