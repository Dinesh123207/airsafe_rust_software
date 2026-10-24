// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AirSafeAnchor
/// @notice Public, append-only registry of Merkle roots of AIRSAFE sensor-reading batches.
/// @dev The AIRSAFE server seals device readings into an RFC 6962 Merkle tree, then writes the root here. Anyone can
///      later prove that a reading was part of a batch (inclusion proof) and that the batch existed no later than
///      `blockTimestamp`, without trusting the server. The contract stores no sensor data, only 32-byte roots.
contract AirSafeAnchor {
    struct Anchor {
        bytes32 root;
        uint64 leafCount;
        uint64 fromMs; // earliest reading time in the batch (unix ms)
        uint64 toMs; // latest reading time in the batch (unix ms)
        uint64 blockTimestamp; // when the root was anchored (unix s)
        address anchoredBy;
    }

    address public owner;
    mapping(address => bool) public anchorers;
    mapping(uint64 => Anchor) private _anchors; // batchId => anchor (batch ids start at 1)
    mapping(bytes32 => uint64) public batchOfRoot; // root => batchId (0 = never anchored)

    event Anchored(
        uint64 indexed batchId,
        bytes32 indexed root,
        uint64 leafCount,
        uint64 fromMs,
        uint64 toMs,
        address indexed anchoredBy
    );
    event AnchorerSet(address indexed account, bool allowed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotAnchorer();
    error BadBatchId();
    error ZeroRoot();
    error ConflictingAnchor();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        anchorers[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit AnchorerSet(msg.sender, true);
    }

    function setAnchorer(address account, bool allowed) external onlyOwner {
        anchorers[account] = allowed;
        emit AnchorerSet(account, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Record the Merkle root of a batch. Idempotent: re-submitting the same (batchId, root) is a no-op, so
    ///         the server can safely retry after a crash. A different root for an existing batch id reverts.
    function anchor(bytes32 root, uint64 batchId, uint64 leafCount, uint64 fromMs, uint64 toMs) external {
        if (!anchorers[msg.sender]) revert NotAnchorer();
        if (batchId == 0) revert BadBatchId();
        if (root == bytes32(0)) revert ZeroRoot();

        Anchor storage existing = _anchors[batchId];
        if (existing.blockTimestamp != 0) {
            if (existing.root == root) return;
            revert ConflictingAnchor();
        }
        _anchors[batchId] = Anchor(root, leafCount, fromMs, toMs, uint64(block.timestamp), msg.sender);
        if (batchOfRoot[root] == 0) batchOfRoot[root] = batchId;
        emit Anchored(batchId, root, leafCount, fromMs, toMs, msg.sender);
    }

    function getAnchor(uint64 batchId) external view returns (Anchor memory) {
        return _anchors[batchId];
    }

    /// @return anchored whether this root was ever anchored; batchId and blockTimestamp describe that anchor.
    function isAnchored(bytes32 root) external view returns (bool anchored, uint64 batchId, uint64 blockTimestamp) {
        batchId = batchOfRoot[root];
        anchored = batchId != 0;
        blockTimestamp = _anchors[batchId].blockTimestamp;
    }
}
