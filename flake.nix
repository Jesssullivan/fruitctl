{
  description = "Fruitctl shared VNC broker, agent adapters and Home Manager integration";

  # This is the reviewed fleet nixpkgs revision, not a floating channel.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/c508844df6c28fa6dabc1b6af70f3ccbd65c5201";
  inputs.home-manager = {
    url = "github:nix-community/home-manager/471e6a065f9efed51488d7c51a9abbd387df91b8";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, home-manager }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      packagesFor = system:
        let pkgs = import nixpkgs { inherit system; };
        in rec {
          fruitctl = pkgs.callPackage ./nix/package.nix { src = self; };
          default = fruitctl;
          runtime = fruitctl;
          proxy = fruitctl;
        } // pkgs.lib.optionalAttrs (system == "aarch64-darwin") {
          # Historical qualified bytes. This does not contain the fresh-frame
          # repair in the current source and is never silently selected by HM.
          legacy-native = pkgs.callPackage ./nix/legacy-native.nix { };
          # Released signed bytes, selected explicitly by the Darwin consumer.
          # The unqualified Host prototype has no public package export.
          native-controller = pkgs.callPackage ./nix/native-controller.nix { };
        };
    in {
      packages = forAllSystems packagesFor;
      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.fruitctl}/bin/fruitctl";
        };
        fruitctl = self.apps.${system}.default;
      });
      homeManagerModules.default = import ./nix/home-manager.nix self;
      homeManagerModules.fruitctl = self.homeManagerModules.default;
      overlays.default = final: _prev: {
        fruitctl = final.callPackage ./nix/package.nix { src = self; };
      };
      checks = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          home-manager-contract = import ./nix/tests/home-manager.nix {
            inherit pkgs;
            homeManagerSource = home-manager;
            fruitctlFlake = self;
          };
        });
    };
}
