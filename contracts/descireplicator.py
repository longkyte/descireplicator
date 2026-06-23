# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
# v0.2.16

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
        paper_url = self.bounty_paper_url[b_key].replace('"', '\\"').replace('\n', '\\n')
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
        url = self.claim_url[c_key].replace('"', '\\"')
        verdict = self.claim_verdict[c_key]
        score = str(self.claim_score[c_key])
        reason = self.claim_reason[c_key].replace('"', '\\"').replace('\n', '\\n')
        evaluated = "true" if self.claim_evaluated[c_key] else "false"
        return f'{{"bounty_id":"{bounty_id}","challenger":"{challenger}","url":"{url}","verdict":"{verdict}","methodology_score":{score},"reason":"{reason}","evaluated":{evaluated}}}'

    @gl.public.view
    def get_next_bounty_id(self) -> int:
        return int(self.next_bounty_id)

    @gl.public.view
    def get_next_claim_id(self) -> int:
        return int(self.next_claim_id)
