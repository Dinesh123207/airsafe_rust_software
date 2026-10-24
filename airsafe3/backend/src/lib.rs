//! AIRSAFE API library. The binary (`main.rs`) wires these modules together; integration tests import them directly.
pub mod analysis;
pub mod anchor;
pub mod auth;
pub mod config;
pub mod crypto;
pub mod error;
pub mod evm;
pub mod merkle;
pub mod models;
pub mod risk;
pub mod routes;
pub mod seed;
pub mod simulator;
pub mod state;
pub mod wallet;
