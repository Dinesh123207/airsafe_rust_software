// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AirSafeAnchor} from "../src/AirSafeAnchor.sol";

// Run with:  cd contracts && forge install foundry-rs/forge-std --no-commit && forge test
contract AirSafeAnchorTest is Test {
    AirSafeAnchor anchorContract;
    bytes32 constant ROOT = keccak256("root");

    function setUp() public {
        anchorContract = new AirSafeAnchor();
    }

    function testAnchorStoresRootAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit AirSafeAnchor.Anchored(1, ROOT, 25, 1000, 2000, address(this));
        anchorContract.anchor(ROOT, 1, 25, 1000, 2000);
        (bool anchored, uint64 batchId,) = anchorContract.isAnchored(ROOT);
        assertTrue(anchored);
        assertEq(batchId, 1);
        assertEq(anchorContract.getAnchor(1).leafCount, 25);
    }

    function testRetryIsIdempotentButConflictReverts() public {
        anchorContract.anchor(ROOT, 1, 25, 1000, 2000);
        anchorContract.anchor(ROOT, 1, 25, 1000, 2000); // no revert
        vm.expectRevert(AirSafeAnchor.ConflictingAnchor.selector);
        anchorContract.anchor(keccak256("other"), 1, 25, 1000, 2000);
    }

    function testOnlyAnchorersAndValidInputs() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(AirSafeAnchor.NotAnchorer.selector);
        anchorContract.anchor(ROOT, 1, 1, 1, 1);

        vm.expectRevert(AirSafeAnchor.BadBatchId.selector);
        anchorContract.anchor(ROOT, 0, 1, 1, 1);
        vm.expectRevert(AirSafeAnchor.ZeroRoot.selector);
        anchorContract.anchor(bytes32(0), 1, 1, 1, 1);

        anchorContract.setAnchorer(address(0xBEEF), true);
        vm.prank(address(0xBEEF));
        anchorContract.anchor(ROOT, 1, 1, 1, 1);
    }
}
