package main

// REQ-032: read Server configuration without exporting secrets into the environment.
import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"
)

func loadConfigFile(path string, required bool, lookupEnvironment func(string) (string, bool)) (serverConfig, error) {
	file, err := os.Open(path)
	if err != nil {
		if !required && errors.Is(err, os.ErrNotExist) {
			return loadConfig(func(name string) string {
				if value, exists := lookupEnvironment(name); exists {
					return value
				}
				return ""
			})
		}
		return serverConfig{}, fmt.Errorf("open Server configuration file: %w", err)
	}
	defer file.Close()
	settings := make(map[string]string)
	scanner := bufio.NewScanner(file)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, value, found := strings.Cut(line, "=")
		if !found {
			return serverConfig{}, fmt.Errorf("Server configuration line %d must use KEY=value", lineNumber)
		}
		name = strings.TrimSpace(name)
		switch name {
		case "SPROUT_API_KEY", "SPROUT_LISTEN_ADDRESS", "SPROUT_DATABASE_PATH", "SPROUT_PUBLIC_ORIGIN":
		default:
			return serverConfig{}, fmt.Errorf("Server configuration line %d has an unsupported field", lineNumber)
		}
		if _, exists := settings[name]; exists {
			return serverConfig{}, fmt.Errorf("Server configuration line %d repeats %s", lineNumber, name)
		}
		value = strings.TrimSpace(value)
		if strings.HasPrefix(value, "\"") || strings.HasPrefix(value, "'") {
			if len(value) < 2 || value[len(value)-1] != value[0] {
				return serverConfig{}, fmt.Errorf("Server configuration line %d has unmatched quotes for %s", lineNumber, name)
			}
			value = value[1 : len(value)-1]
		}
		settings[name] = value
	}
	if err := scanner.Err(); err != nil {
		return serverConfig{}, fmt.Errorf("read Server configuration near line %d: %w", lineNumber+1, err)
	}
	return loadConfig(func(name string) string {
		if value, exists := lookupEnvironment(name); exists {
			return value
		}
		return settings[name]
	})
}
