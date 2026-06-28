.PHONY: build test fmt clippy

build:
	stellar contract build

test:
	cargo test

fmt:
	cargo fmt -- --check

clippy:
	cargo clippy -- -D warnings