/**
 * WebSocket Configuration Finder
 *
 * Run this script in the browser console on the live betting site
 * to extract Pusher/WebSocket configuration
 */

console.log('🔍 Searching for WebSocket configuration...\n');

// Check for Pusher instance
if (window.Pusher) {
  console.log('✅ Found Pusher library');

  // Try to find Pusher instances
  const pusherKeys = Object.keys(window).filter(key =>
    window[key] && window[key].connection && window[key].connection.socket
  );

  pusherKeys.forEach(key => {
    const instance = window[key];
    console.log(`\n📡 Pusher instance found: ${key}`);
    console.log('Config:', {
      key: instance.key || 'unknown',
      wsHost: instance.config?.wsHost,
      wsPort: instance.config?.wsPort,
      wssPort: instance.config?.wssPort,
      cluster: instance.config?.cluster,
      encrypted: instance.config?.encrypted
    });

    if (instance.connection?.socket?.url) {
      console.log('WebSocket URL:', instance.connection.socket.url);
    }
  });
}

// Check for Laravel Echo
if (window.Echo) {
  console.log('\n✅ Found Laravel Echo');
  console.log('Echo connector:', window.Echo.connector?.pusher?.key);

  if (window.Echo.connector?.pusher?.config) {
    console.log('Echo Pusher config:', {
      wsHost: window.Echo.connector.pusher.config.wsHost,
      wsPort: window.Echo.connector.pusher.config.wsPort,
      key: window.Echo.connector.pusher.key
    });
  }
}

// Search page source for Pusher configuration
console.log('\n🔍 Checking page source...');
const scripts = Array.from(document.scripts);
const pusherConfigs = [];

scripts.forEach(script => {
  const content = script.innerHTML;

  // Look for Pusher initialization
  const pusherMatch = content.match(/new\s+Pusher\s*\(\s*['"]([^'"]+)['"]\s*,\s*({[^}]+})/);
  if (pusherMatch) {
    console.log('\n📝 Found Pusher initialization in script:');
    console.log('Key:', pusherMatch[1]);
    console.log('Config:', pusherMatch[2]);
    pusherConfigs.push({ key: pusherMatch[1], config: pusherMatch[2] });
  }

  // Look for wsHost
  const wsHostMatch = content.match(/wsHost\s*:\s*['"]([^'"]+)['"]/);
  if (wsHostMatch) {
    console.log('wsHost found:', wsHostMatch[1]);
  }
});

// Check for WebSocket connections in Network tab (if accessible)
console.log('\n💡 Next steps:');
console.log('1. Open DevTools → Network tab');
console.log('2. Filter by WS (WebSocket)');
console.log('3. Reload the page');
console.log('4. Look for wss:// connections');
console.log('5. Copy the WebSocket URL');

if (pusherConfigs.length === 0) {
  console.log('\n⚠️ No Pusher config found in page source');
  console.log('Check the Network tab for WebSocket connections');
}
