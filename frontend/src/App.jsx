import React, { useState, useEffect } from 'react';
import { createClient, createAccount } from 'genlayer-js';
import { localnet, studionet } from 'genlayer-js/chains';
import { 
  Award, 
  BookOpen, 
  ShieldAlert, 
  RefreshCw, 
  ExternalLink, 
  PlusCircle, 
  Terminal, 
  Settings, 
  Activity, 
  FileText, 
  CheckCircle2, 
  XCircle, 
  AlertCircle, 
  Coins, 
  Wallet, 
  Dna,
  FileCheck
} from 'lucide-react';

// Pre-loaded Python contract code for one-click deployment from the UI!
const CONTRACT_CODE = `# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

# Define the interface for transferring native GEN tokens to researchers (EOA or EVM contracts)
@gl.evm.contract_interface
class _Recipient:
    class View: pass
    class Write: pass

class Contract(gl.Contract):
    # Persistent storage fields
    next_bounty_id: u256
    next_claim_id: u256
    
    # Bounty details (using str keys for TreeMap to ensure maximum compatibility in GenVM)
    bounty_funder: TreeMap[str, str]
    bounty_paper_url: TreeMap[str, str]
    bounty_balance: TreeMap[str, u256]
    bounty_active: TreeMap[str, bool]
    
    # Claim details (using str keys for TreeMap to ensure maximum compatibility in GenVM)
    claim_bounty_id: TreeMap[str, u256]
    claim_challenger: TreeMap[str, str]
    claim_url: TreeMap[str, str]
    claim_verdict: TreeMap[str, str]
    claim_score: TreeMap[str, u256]
    claim_reason: TreeMap[str, str]
    claim_evaluated: TreeMap[str, bool]

    def __init__(self):
        # NOTE: TreeMap and DynArray fields are pre-initialized by the GenVM.
        # Re-assigning them here will trigger a VM AssertionError.
        self.next_bounty_id = u256(0)
        self.next_claim_id = u256(0)

    @gl.public.write.payable
    def create_bounty(self, paper_url: str) -> int:
        """
        Allows a funder or DAO to lock native GEN tokens as a bounty for debunking
        a specific scientific paper. Returns the created bounty_id.
        """
        funds = gl.message.value
        if funds <= u256(0):
            raise gl.vm.UserError("Must fund the bounty pool with native tokens")
        
        if len(paper_url.strip()) == 0:
            raise gl.vm.UserError("Paper URL cannot be empty")
        
        bounty_id = int(self.next_bounty_id)
        b_key = str(bounty_id)
        
        self.bounty_funder[b_key] = str(gl.message.sender_address)
        self.bounty_paper_url[b_key] = paper_url
        self.bounty_balance[b_key] = funds
        self.bounty_active[b_key] = True
        
        self.next_bounty_id = self.next_bounty_id + u256(1)
        return bounty_id

    @gl.public.write
    def submit_claim(self, bounty_id: int, replication_url: str) -> int:
        """
        Submits a replication study URL to claim the bounty.
        Scrapes both the original and replication papers, runs AI consensus evaluation,
        and payouts the bounty if the review board agrees the study was successfully debunked.
        """
        b_key = str(bounty_id)
        
        # Validate bounty status
        if u256(bounty_id) >= self.next_bounty_id:
            raise gl.vm.UserError("Target bounty does not exist")
        if not self.bounty_active[b_key]:
            raise gl.vm.UserError("Bounty is inactive or funds have already been distributed")
        if len(replication_url.strip()) == 0:
            raise gl.vm.UserError("Replication URL cannot be empty")
            
        claim_id = int(self.next_claim_id)
        c_key = str(claim_id)
        
        self.claim_bounty_id[c_key] = u256(bounty_id)
        self.claim_challenger[c_key] = str(gl.message.sender_address)
        self.claim_url[c_key] = replication_url
        self.claim_verdict[c_key] = "PENDING"
        self.claim_score[c_key] = u256(0)
        self.claim_reason[c_key] = ""
        self.claim_evaluated[c_key] = False
        
        self.next_claim_id = self.next_claim_id + u256(1)
        
        # Load the original paper URL
        original_url = self.bounty_paper_url[b_key]
        
        # Define Leader non-deterministic task
        def leader_fn():
            try:
                # 1. Scrape original paper content using web.render
                orig_content = gl.nondet.web.render(original_url, mode="text")
                if not orig_content or len(orig_content.strip()) < 100:
                    return {
                        "verdict": "REJECTED",
                        "methodology_score": 0,
                        "reason": "Original paper URL could not be read or contains insufficient content (under 100 characters)."
                    }
                
                # 2. Scrape replication paper content using web.render
                repl_content = gl.nondet.web.render(replication_url, mode="text")
                if not repl_content or len(repl_content.strip()) < 100:
                    return {
                        "verdict": "REJECTED",
                        "methodology_score": 0,
                        "reason": "Replication paper URL could not be read or contains insufficient content (under 100 characters)."
                    }
                
                # Truncate both to 4000 characters to fit in LLM context limits safely
                trunc_orig = orig_content[:4000]
                trunc_repl = repl_content[:4000]
                
                # 3. Build AI review prompt
                prompt = f"""
                You are an AI Editor-in-Chief of a Decentralized Science (DeSci) Review Board.
                Your task is to evaluate a replication/debunking claim against an original study.
                
                [Original Study Content]:
                {trunc_orig}
                
                [Replication Study Content]:
                {trunc_repl}
                
                Analyze both papers and answer:
                1. Is the replication study's methodology sound and scientific?
                2. Does the replication study actually expose a critical flaw, error, or replication failure in the original study?
                
                You must output a verdict:
                - DEBUNKED: The replication study successfully debunks or refutes the original study.
                - REJECTED: The replication study fails to disprove the original study.
                
                Respond ONLY with a JSON object in this exact schema:
                {{
                    "verdict": "DEBUNKED" or "REJECTED",
                    "methodology_score": <integer from 0 to 100>,
                    "reason": "<brief justification details>"
                }}
                """
                
                # 4. Request LLM evaluation with JSON format requirement
                ai_res = gl.nondet.exec_prompt(prompt, response_format="json")
                
                # Validate type and parse outputs
                if not isinstance(ai_res, dict):
                    raise gl.vm.UserError("AI response did not parse as a dictionary")
                
                verdict = str(ai_res.get("verdict", "REJECTED")).upper()
                if verdict not in ["DEBUNKED", "REJECTED"]:
                    verdict = "REJECTED"
                
                score = int(ai_res.get("methodology_score", 0))
                score = max(0, min(100, score))
                
                reason = str(ai_res.get("reason", "No justification provided."))
                
                return {
                    "verdict": verdict,
                    "methodology_score": score,
                    "reason": reason
                }
            except Exception as e:
                # Graceful handling of errors inside leader_fn to prevent transaction revert
                # and allow the contract to record the failure feedback on-chain.
                return {
                    "verdict": "REJECTED",
                    "methodology_score": 0,
                    "reason": f"Evaluation error: {str(e)}"
                }

        # Define Validator non-deterministic task
        def validator_fn(leaders_res):
            # Validate structure of leader's proposed response
            if not isinstance(leaders_res, gl.vm.Return):
                return False
                
            leader_data = leaders_res.calldata
            if not isinstance(leader_data, dict) or "verdict" not in leader_data:
                return False
                
            # Validator independently re-runs the dual extraction and AI evaluation
            my_res = leader_fn()
            
            # Semantic equivalence check:
            # Validators must agree on the binary decision (DEBUNKED or REJECTED)
            return my_res["verdict"] == leader_data["verdict"]

        # Run non-deterministic equivalence protocol
        result = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        
        # Update contract state in deterministic scope
        self.claim_verdict[c_key] = result["verdict"]
        self.claim_score[c_key] = u256(result["methodology_score"])
        self.claim_reason[c_key] = result["reason"]
        self.claim_evaluated[c_key] = True
        
        # If approved, release and transfer locked bounty funds
        if result["verdict"] == "DEBUNKED":
            amount = self.bounty_balance[b_key]
            if amount > u256(0) and self.bounty_active[b_key]:
                # Update state variables BEFORE the external transfer to prevent re-entrancy
                self.bounty_active[b_key] = False
                self.bounty_balance[b_key] = u256(0)
                
                # Emit transfer to the challenger EOA or EVM wallet address
                _Recipient(Address(self.claim_challenger[c_key])).emit_transfer(value=amount)
                
        return claim_id

    # Public Read Getters
    @gl.public.view
    def get_bounty_json(self, bounty_id: int) -> str:
        """
        Returns the details of a bounty formatted as a JSON string for easy client consumption.
        """
        b_key = str(bounty_id)
        if u256(bounty_id) >= self.next_bounty_id:
            return '{}'
        funder = self.bounty_funder[b_key]
        paper_url = self.bounty_paper_url[b_key].replace('"', '\\\\"').replace('\\n', '\\\\n')
        balance = str(self.bounty_balance[b_key])
        active = "true" if self.bounty_active[b_key] else "false"
        return f'{{"funder":"{funder}","paper_url":"{paper_url}","balance":"{balance}","active":{active}}}'

    @gl.public.view
    def get_claim_json(self, claim_id: int) -> str:
        """
        Returns the details of a claim formatted as a JSON string for easy client consumption.
        """
        c_key = str(claim_id)
        if u256(claim_id) >= self.next_claim_id:
            return '{}'
        bounty_id = str(self.claim_bounty_id[c_key])
        challenger = self.claim_challenger[c_key]
        url = self.claim_url[c_key].replace('"', '\\\\"')
        verdict = self.claim_verdict[c_key]
        score = str(self.claim_score[c_key])
        reason = self.claim_reason[c_key].replace('"', '\\\\"').replace('\\n', '\\\\n')
        evaluated = "true" if self.claim_evaluated[c_key] else "false"
        return f'{{"bounty_id":"{bounty_id}","challenger":"{challenger}","url":"{url}","verdict":"{verdict}","methodology_score":{score},"reason":"{reason}","evaluated":{evaluated}}}'

    @gl.public.view
    def get_next_bounty_id(self) -> int:
        return int(self.next_bounty_id)

    @gl.public.view
    def get_next_claim_id(self) -> int:
        return int(self.next_claim_id)
`;

export default function App() {
  const defaultContractAddress = import.meta.env.VITE_CONTRACT_ADDRESS || '0xA315505C469df0e8a53F38441Fc02909f2A08dF8';
  const defaultRpcUrl = import.meta.env.VITE_RPC_URL || 'https://studio.genlayer.com/api';

  // Client and RPC settings
  const [rpcUrl, setRpcUrl] = useState(defaultRpcUrl);
  const [client, setClient] = useState(null);
  const [account, setAccount] = useState(null);
  const [accountBalance, setAccountBalance] = useState('0');
  const [contractAddress, setContractAddress] = useState(defaultContractAddress);
  
  // App views/navigation
  const [activeTab, setActiveTab] = useState('bounties'); // 'bounties' | 'history' | 'contract'
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [error, setError] = useState(null);

  // Business state
  const [bounties, setBounties] = useState([]);
  const [claims, setClaims] = useState([]);
  
  // Form state
  const [originalPaperUrl, setOriginalPaperUrl] = useState('');
  const [bountyFunds, setBountyFunds] = useState('50');
  const [targetBountyId, setTargetBountyId] = useState('');
  const [replicationUrl, setReplicationUrl] = useState('');

  // Initialize account and client on mount/RPC change
  useEffect(() => {
    try {
      // 1. Create a simulated account
      let storedKey = localStorage.getItem('descireplicator_privkey');
      let act;
      if (storedKey) {
        act = createAccount(storedKey);
      } else {
        act = createAccount(); // Generates a new random account
        localStorage.setItem('descireplicator_privkey', act.privateKey);
      }
      setAccount(act);

      // 2. Setup Client
      let customChain;
      if (rpcUrl.includes('studio.genlayer.com')) {
        customChain = studionet;
      } else {
        customChain = {
          ...localnet,
          rpcUrls: {
            default: { http: [rpcUrl] },
            public: { http: [rpcUrl] },
          }
        };
      }

      const cl = createClient({
        chain: customChain,
        account: act,
      });
      setClient(cl);
      setError(null);
      
      // Load contract address if saved
      const savedContract = localStorage.getItem('descireplicator_contract');
      if (savedContract) {
        setContractAddress(savedContract);
      } else {
        setContractAddress(defaultContractAddress);
      }
    } catch (e) {
      console.error(e);
      setError('Failed to initialize client: ' + e.message);
    }
  }, [rpcUrl]);

  // Load dashboard data once contract address and client are set
  useEffect(() => {
    if (contractAddress && client) {
      refreshData();
    }
  }, [contractAddress, client]);

  // Function to refresh balance, bounties, and claims
  const refreshData = async () => {
    if (!client || !contractAddress) return;
    try {
      setError(null);
      // Get account balance
      if (account) {
        const bal = await client.getBalance({ address: account.address });
        setAccountBalance(bal ? bal.toString() : '0');
      }

      // Get next bounty ID
      const nextBountyId = await client.readContract({
        address: contractAddress,
        functionName: 'get_next_bounty_id',
        args: [],
      });
      const numBounties = Number(nextBountyId || 0);

      // Load all bounties
      const loadedBounties = [];
      for (let i = 0; i < numBounties; i++) {
        try {
          const jsonStr = await client.readContract({
            address: contractAddress,
            functionName: 'get_bounty_json',
            args: [BigInt(i)],
          });
          const bounty = JSON.parse(jsonStr);
          if (bounty && bounty.funder) {
            loadedBounties.push({ id: i, ...bounty });
          }
        } catch (err) {
          console.error('Error loading bounty ' + i, err);
        }
      }
      setBounties(loadedBounties.reverse()); // Latest first

      // Get next claim ID
      const nextClaimId = await client.readContract({
        address: contractAddress,
        functionName: 'get_next_claim_id',
        args: [],
      });
      const numClaims = Number(nextClaimId || 0);

      // Load all claims
      const loadedClaims = [];
      for (let i = 0; i < numClaims; i++) {
        try {
          const jsonStr = await client.readContract({
            address: contractAddress,
            functionName: 'get_claim_json',
            args: [BigInt(i)],
          });
          const claim = JSON.parse(jsonStr);
          if (claim && claim.challenger) {
            loadedClaims.push({ id: i, ...claim });
          }
        } catch (err) {
          console.error('Error loading claim ' + i, err);
        }
      }
      setClaims(loadedClaims.reverse()); // Show latest first
    } catch (e) {
      console.error(e);
      setError('Failed to refresh data: ' + e.message + '. Ensure the contract address and RPC node are correct.');
    }
  };

  // Deploy new contract from the UI
  const handleDeployContract = async () => {
    if (!client) return;
    setLoading(true);
    setLoadingMessage('Initializing consensus & compiling Python contract...');
    setError(null);
    try {
      // 1. Initialize Consensus Smart Contract (required by GenLayer client before deployment)
      await client.initializeConsensusSmartContract();
      
      setLoadingMessage('Deploying DeSci Replicator Intelligent Contract to GenLayer...');
      // 2. Deploy
      const txHash = await client.deployContract({
        code: CONTRACT_CODE,
        args: [],
        leaderOnly: false,
      });

      setLoadingMessage('Waiting for block acceptance (Consensus execution)...');
      const receipt = await client.waitForTransactionReceipt({
        hash: txHash,
        status: 'ACCEPTED',
        retries: 30,
        interval: 3000,
      });

      const deployedAddr = receipt.data?.contract_address;
      if (deployedAddr) {
        setContractAddress(deployedAddr);
        localStorage.setItem('descireplicator_contract', deployedAddr);
      } else {
        throw new Error('Deployment accepted but no contract address returned.');
      }
      await refreshData();
    } catch (e) {
      console.error(e);
      setError('Contract deployment failed: ' + e.message);
    } finally {
      setLoading(false);
      setLoadingMessage('');
    }
  };

  // Create new bounty
  const handleCreateBounty = async (e) => {
    e.preventDefault();
    if (!client || !contractAddress) return;
    if (!originalPaperUrl || !bountyFunds) return;
    setLoading(true);
    setLoadingMessage('Broadcasting bounty pool creation transaction...');
    setError(null);
    try {
      const amountInWei = BigInt(bountyFunds);
      const txHash = await client.writeContract({
        address: contractAddress,
        functionName: 'create_bounty',
        args: [originalPaperUrl],
        value: amountInWei,
      });

      setLoadingMessage('Waiting for consensus confirmation...');
      await client.waitForTransactionReceipt({
        hash: txHash,
        status: 'ACCEPTED',
        retries: 30,
        interval: 3000,
      });

      setOriginalPaperUrl('');
      await refreshData();
    } catch (e) {
      console.error(e);
      setError('Failed to create bounty: ' + e.message);
    } finally {
      setLoading(false);
      setLoadingMessage('');
    }
  };

  // Submit claim (Debunk attempt)
  const handleSubmitClaim = async (e) => {
    e.preventDefault();
    if (!client || !contractAddress) return;
    if (targetBountyId === '' || !replicationUrl) return;
    setLoading(true);
    setLoadingMessage('Submitting claim. Validators are launching dual scraping renders...');
    setError(null);
    try {
      const txHash = await client.writeContract({
        address: contractAddress,
        functionName: 'submit_claim',
        args: [BigInt(targetBountyId), replicationUrl],
      });

      setLoadingMessage('Awaiting scientific AI consensus evaluation (scraping & evaluating both studies)...');
      await client.waitForTransactionReceipt({
        hash: txHash,
        status: 'ACCEPTED',
        retries: 50,
        interval: 4000,
      });

      setReplicationUrl('');
      setTargetBountyId('');
      setActiveTab('history');
      await refreshData();
    } catch (e) {
      console.error(e);
      setError('Failed to submit claim: ' + e.message);
    } finally {
      setLoading(false);
      setLoadingMessage('');
    }
  };

  // Quick action to start challenge on a bounty
  const selectBountyForChallenge = (id) => {
    setTargetBountyId(id.toString());
    const element = document.getElementById('claim-form-section');
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div>
      {/* Header */}
      <header className="app-header">
        <div className="brand">
          <div className="brand-logo"><Dna size={22} strokeWidth={2.5} /></div>
          <h1 className="brand-name">DeSci Replicator</h1>
        </div>
        <div className="connection-status">
          <span className={`status-dot ${contractAddress ? 'connected' : ''}`}></span>
          {contractAddress ? 'Connected to Contract' : 'Not Connected'}
        </div>
      </header>

      <div className="container">
        {/* Hero Section */}
        <section className="hero-section">
          <div className="hero-tag">Decentralized Peer-Review board</div>
          <h2 className="hero-title">Debunk Flawed Science.<br />Claim Autonomous Bounties.</h2>
          <p className="hero-subtitle">
            DeSci Replicator financially rewards researchers who critique, replicate, and correct scientific research. Powered by GenLayer AI Validators, the contract automatically scrapes and evaluates both the original paper and the challenge paper to verify consensus and distribute funds.
          </p>
        </section>

        {/* Global Connection Settings */}
        <section className="glass-card" style={{ marginBottom: '2.5rem' }}>
          <h3 className="card-title">
            <span className="card-title-icon"><Settings size={20} /></span> Network & Contract Settings
          </h3>
          <div className="dashboard-grid" style={{ gridTemplateColumns: '1.5fr 1.5fr', gap: '1.5rem' }}>
            <div className="form-group">
              <label className="form-label">GenLayer RPC Node API</label>
              <input
                className="form-input"
                value={rpcUrl}
                onChange={(e) => setRpcUrl(e.target.value)}
                placeholder="https://studio.genlayer.com/api"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Intelligent Contract Address</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  className="form-input"
                  value={contractAddress}
                  onChange={(e) => {
                    setContractAddress(e.target.value);
                    localStorage.setItem('descireplicator_contract', e.target.value);
                  }}
                  placeholder="0x..."
                />
                <button 
                  className="btn btn-primary" 
                  onClick={handleDeployContract} 
                  disabled={loading}
                  style={{ width: 'auto', whiteSpace: 'nowrap' }}
                >
                  <RefreshCw size={16} /> Deploy New
                </button>
              </div>
            </div>
          </div>
          {account && (
            <div className="wallet-info">
              <div className="wallet-row">
                <span className="wallet-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Wallet size={14} /> Local Simulated EOA Address:
                </span>
                <span className="wallet-value">{account.address}</span>
              </div>
              <div className="wallet-row">
                <span className="wallet-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Coins size={14} /> Account Balance:
                </span>
                <span className="wallet-value wallet-balance">{accountBalance} GEN</span>
              </div>
            </div>
          )}
        </section>

        {/* Errors Block */}
        {error && (
          <section className="glass-card error-card" style={{ marginBottom: '2.5rem' }}>
            <h4 className="error-title">
              <AlertCircle size={20} /> System Execution Error
            </h4>
            <p className="error-msg">{error}</p>
          </section>
        )}

        {/* Tab Navigation */}
        <nav className="tabs-nav">
          <button 
            className={`tab-btn ${activeTab === 'bounties' ? 'active' : ''}`}
            onClick={() => setActiveTab('bounties')}
          >
            Active Bounties & Claims
          </button>
          <button 
            className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            AI Review Board Logs
          </button>
          <button 
            className={`tab-btn ${activeTab === 'contract' ? 'active' : ''}`}
            onClick={() => setActiveTab('contract')}
          >
            Contract Python Source
          </button>
        </nav>

        {/* Tab 1: Active Bounties and Claims Forms */}
        {activeTab === 'bounties' && (
          <div className="dashboard-grid">
            {/* Left Column: Form Submissions */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              
              {/* Form 1: Fund / Create Bounty */}
              <div className="glass-card">
                {loading && loadingMessage.includes('bounty') && (
                  <div className="loading-overlay">
                    <div className="loading-ring"></div>
                    <div className="loading-text">{loadingMessage}</div>
                    <div className="loading-subtext">Executing on-chain transaction...</div>
                  </div>
                )}
                
                <h3 className="card-title">
                  <span className="card-title-icon"><PlusCircle size={22} /></span> Create Bounty Pool
                </h3>
                <form onSubmit={handleCreateBounty}>
                  <div className="form-group">
                    <label className="form-label">Original Paper URL (ArXiv, Medium, Notion, PDF)</label>
                    <input
                      className="form-input"
                      value={originalPaperUrl}
                      onChange={(e) => setOriginalPaperUrl(e.target.value)}
                      placeholder="e.g. https://arxiv.org/abs/2304.12345"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Locked Bounty Funds (GEN Tokens)</label>
                    <input
                      className="form-input"
                      type="number"
                      value={bountyFunds}
                      onChange={(e) => setBountyFunds(e.target.value)}
                      placeholder="e.g. 50"
                      min="1"
                      required
                    />
                  </div>
                  <button className="btn btn-primary" type="submit" disabled={loading || !contractAddress}>
                    <Coins size={18} /> Lock Funds & Post Bounty
                  </button>
                </form>
              </div>

              {/* Form 2: Challenger Claim Form */}
              <div className="glass-card" id="claim-form-section">
                {loading && loadingMessage.includes('claim') && (
                  <div className="loading-overlay">
                    <div className="loading-ring"></div>
                    <div className="loading-text">{loadingMessage}</div>
                    <div className="loading-subtext">Running dual-page scraping & AI Validator review...</div>
                  </div>
                )}
                
                <h3 className="card-title">
                  <span className="card-title-icon"><Award size={22} /></span> Challenge Scientific Study
                </h3>
                <form onSubmit={handleSubmitClaim}>
                  <div className="form-group">
                    <label className="form-label">Target Bounty ID</label>
                    <input
                      className="form-input"
                      type="number"
                      value={targetBountyId}
                      onChange={(e) => setTargetBountyId(e.target.value)}
                      placeholder="e.g. 0"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Your Replication / Debunking Paper URL</label>
                    <input
                      className="form-input"
                      value={replicationUrl}
                      onChange={(e) => setReplicationUrl(e.target.value)}
                      placeholder="e.g. https://github.com/my-replication-study"
                      required
                    />
                  </div>
                  <button className="btn btn-primary" type="submit" disabled={loading || !contractAddress}>
                    <ShieldAlert size={18} /> Submit Replication Challenge
                  </button>
                </form>
              </div>

            </div>

            {/* Right Column: List of Bounties */}
            <div className="glass-card">
              <h3 className="card-title">
                <span className="card-title-icon"><BookOpen size={22} /></span> Scientific Bounty Pools
              </h3>
              
              {bounties.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon"><FileText size={40} /></div>
                  <p>No active scientific bounties posted yet.</p>
                  <p style={{ fontSize: '0.85rem' }}>Be the first funder to lock tokens for a paper debunk challenge!</p>
                </div>
              ) : (
                <div className="list-container">
                  {bounties.map((b) => (
                    <div key={b.id} className="item-card">
                      <div className="item-header">
                        <div>
                          <div className="item-id">Bounty Pool #{b.id}</div>
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Posted by: {b.funder}</div>
                        </div>
                        <span className={`badge ${b.active ? 'badge-active' : 'badge-completed'}`}>
                          {b.active ? 'Active Challenge' : 'Claimed / Closed'}
                        </span>
                      </div>

                      <div className="item-url">
                        <BookOpen size={14} /> 
                        <strong>Target Paper:</strong> 
                        <a href={b.paper_url} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                          Open Source Link <ExternalLink size={12} />
                        </a>
                      </div>
                      
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.01)', padding: '0.5rem 0.85rem', borderRadius: '0.5rem', border: '1px solid var(--border-dim)' }}>
                        <span style={{ fontFamily: 'monospace' }}>{b.paper_url}</span>
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                        <div className="pool-amount">
                          {b.balance} <span>GEN locked</span>
                        </div>
                        {b.active && (
                          <button 
                            className="btn btn-secondary" 
                            onClick={() => selectBountyForChallenge(b.id)}
                            style={{ width: 'auto', padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                          >
                            Challenge Bounty
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 2: AI Review Logs */}
        {activeTab === 'history' && (
          <div className="glass-card">
            <h3 className="card-title">
              <span className="card-title-icon"><Activity size={22} /></span> Academic Consensus Review Logs
            </h3>
            
            {claims.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"><FileCheck size={40} /></div>
                <p>No evaluation claims have been logged yet.</p>
                <p style={{ fontSize: '0.85rem' }}>When researchers submit replication studies, GenLayer AI Validators will render, critique, and post review logs here.</p>
              </div>
            ) : (
              <div className="list-container">
                {claims.map((c) => (
                  <div key={c.id} className="item-card">
                    <div className="item-header">
                      <div>
                        <div className="item-id" style={{ color: 'var(--accent-cyan)' }}>Claim Challenge #{c.id}</div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                          Bounty Target Pool: <strong style={{ color: 'var(--accent-purple)' }}>#{c.bounty_id}</strong> | Challenged by: {c.challenger}
                        </div>
                      </div>
                      <span className={`badge ${
                        c.verdict === 'DEBUNKED' ? 'badge-debunked' : 
                        c.verdict === 'REJECTED' ? 'badge-rejected' : 'badge-pending'
                      }`}>
                        {c.verdict}
                      </span>
                    </div>

                    <div className="item-url">
                      <FileCheck size={14} /> 
                      <strong>Replication Paper:</strong> 
                      <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                        Replication Link <ExternalLink size={12} />
                      </a>
                    </div>
                    
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.01)', padding: '0.5rem 0.85rem', borderRadius: '0.5rem', border: '1px solid var(--border-dim)' }}>
                      <span style={{ fontFamily: 'monospace' }}>{c.url}</span>
                    </div>

                    <div className="eval-details">
                      <div className="eval-row">
                        <span className="eval-label">Consensus Status:</span>
                        <span className="eval-value">
                          {c.evaluated ? (
                            <span style={{ color: 'var(--accent-neon-green)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                              <CheckCircle2 size={14} /> Consensus Accepted on-chain
                            </span>
                          ) : (
                            <span style={{ color: 'var(--accent-cyan)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                              <Activity size={14} /> Processing Consensus...
                            </span>
                          )}
                        </span>
                      </div>

                      <div className="eval-row">
                        <span className="eval-label">Methodology Score:</span>
                        <span className="eval-value score">{c.methodology_score} / 100</span>
                      </div>

                      <div className="eval-row">
                        <span className="eval-label">AI Consensus Feedback:</span>
                        <span className="eval-value" style={{ fontStyle: 'italic' }}>
                          "{c.reason || 'Evaluation in progress...'}"
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Contract Code */}
        {activeTab === 'contract' && (
          <div className="glass-card">
            <h3 className="card-title">
              <span className="card-title-icon"><Terminal size={22} /></span> Intelligent Python Contract
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginBottom: '1.5rem', lineHeight: '1.5' }}>
              DeSci Replicator is written as a GenLayer Intelligent Contract in Python. The contract is executed by multiple AI Validators that non-deterministically retrieve contents from both the original study and the challenge study, evaluate their methodology, and coordinate on a binary consensus verdict.
            </p>
            
            <div className="code-header">
              <span className="code-title">descireplicator.py</span>
              <span style={{ fontSize: '0.75rem', background: 'rgba(255,255,255,0.06)', padding: '0.25rem 0.5rem', borderRadius: '4px', color: 'var(--accent-cyan)' }}>
                GenVM v0.2.16 Compatible
              </span>
            </div>
            <div className="code-container">
              <pre className="code-block">
                <code>{CONTRACT_CODE}</code>
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
