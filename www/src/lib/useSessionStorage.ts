import { useState, useEffect } from 'react'

export function useSessionStorage<T>(key: string, initialValue: T): [T, (value: T) => void] {
    const [storedValue, setStoredValue] = useState<T>(() => {
        if (typeof window === 'undefined') return initialValue
        try {
            const item = window.sessionStorage.getItem(key)
            return item ? JSON.parse(item) : initialValue
        } catch (error) {
            console.warn(`Error reading sessionStorage key "${key}":`, error)
            return initialValue
        }
    })

    const setValue = (value: T) => {
        try {
            setStoredValue(value)
            if (typeof window !== 'undefined') {
                window.sessionStorage.setItem(key, JSON.stringify(value))
            }
        } catch (error) {
            console.warn(`Error setting sessionStorage key "${key}":`, error)
        }
    }

    return [storedValue, setValue]
}
