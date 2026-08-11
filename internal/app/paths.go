package app

import (
	"os"
	"path/filepath"
)

func DataDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "nav"), nil
}

func DatabasePath() (string, error) {
	dir, err := DataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "nav.db"), nil
}
