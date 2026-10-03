package main

// REQ-032: configuration precedence, compatibility, and secret-safe failures.
import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigFileValuesAndEnvironmentOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	contents := "# Server config\n\nSPROUT_API_KEY=\"file-key\"\nSPROUT_LISTEN_ADDRESS=127.0.0.1:8080\nSPROUT_DATABASE_PATH='/persistent/notes.db'\n"
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	for _, required := range []bool{false, true} {
		config, err := loadConfigFile(path, required, func(string) (string, bool) { return "", false })
		if err != nil {
			t.Fatal(err)
		}
		if config.apiKey != "file-key" || config.listenAddress != "127.0.0.1:8080" || config.databasePath != "/persistent/notes.db" {
			t.Fatalf("incorrect file configuration")
		}
	}
	config, err := loadConfigFile(path, true, func(name string) (string, bool) { return "environment-key", name == "SPROUT_API_KEY" })
	if err != nil || config.apiKey != "environment-key" {
		t.Fatalf("environment override failed: %v", err)
	}
	_, err = loadConfigFile(path, true, func(name string) (string, bool) { return "", name == "SPROUT_API_KEY" })
	if err == nil || !strings.Contains(err.Error(), "SPROUT_API_KEY") {
		t.Fatal("empty environment Key must fail")
	}
}

func TestConfigFileMissingAndUnreadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.env")
	lookup := func(name string) (string, bool) { return "environment-key", name == "SPROUT_API_KEY" }
	config, err := loadConfigFile(path, false, lookup)
	if err != nil || config.apiKey != "environment-key" {
		t.Fatalf("legacy environment startup failed: %v", err)
	}
	if _, err := loadConfigFile(path, true, lookup); err == nil {
		t.Fatal("explicit missing file must fail")
	}
	if _, err := loadConfigFile(filepath.Dir(path), false, lookup); err == nil {
		t.Fatal("directory configuration must fail")
	}
}

func TestConfigFileRejectsInvalidContentWithoutLeakingKey(t *testing.T) {
	for _, contents := range []string{
		"secret-value-without-equals",
		"secret-value=unknown",
		"SPROUT_API_KEY=secret-value\nSPROUT_API_KEY=another",
		"SPROUT_API_KEY=\"secret-value",
		"SPROUT_API_KEY=" + strings.Repeat("secret-value", 10000),
		"SPROUT_API_KEY=\n",
	} {
		path := filepath.Join(t.TempDir(), ".env")
		if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := loadConfigFile(path, true, func(string) (string, bool) { return "", false })
		if err == nil {
			t.Fatal("invalid configuration accepted")
		}
		if strings.Contains(err.Error(), "secret-value") {
			t.Fatal("configuration error leaked secret")
		}
	}
}
