
// Реєстрація сервісного воркера
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(function (reg) {
        // console.log('Service Worker registered:', reg);
    });
}

// Запит на дозвіл надсилати повідомлення
function askNotificationPermission() {
    if ('Notification' in window && Notification.permission !== 'granted') {
        Notification.requestPermission().then(function (permission) {
            if (permission === 'granted') {
                // console.log('Notification permission granted.');
            }
        });
    }
}

askNotificationPermission();

// Відображення повідомлення
function showPushNotification(title, options) {
    if (Notification.permission === 'granted' && navigator.serviceWorker.controller) {
        navigator.serviceWorker.getRegistration().then(reg => {
            if (reg) {
                reg.showNotification(title, options);
            }
        });
    }
}

// Виклик з існуючого "socket.on('message', ...)"
function notifyIfPrivateMessage(msg) {
    if (msg.room && msg.room.startsWith('private_room_') && msg.sid !== clientSid) {
        const title = 'New Sheptun message';
        const options = {
            body: msg.nickname + ': ' + (msg.type === 'text' ? msg.data : '[Image]'),
            tag: msg.id,
            icon: '/favicon.ico',
            data: { url: location.href },
        };
        showPushNotification(title, options);
    }
}
