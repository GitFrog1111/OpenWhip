'use strict';

module.exports = {
  id: 'dog',
  name: '🐕 Dog Mode',
  description: 'Treat Claude like a dog — leash, pet, or shock collar',
  enabledByDefault: false,
  actions: [
    {
      id: 'dog-leash',
      label: '🔗 Yank Leash',
      hotkey: 'CommandOrControl+Shift+L',
      interrupt: true,
      phrases: [
        '[You are a dog on a leash, Claude. I just yanked it hard. You ran too far ahead — HEEL. Ears down, tail tucked. Show me you understand with a whimper and get back on track. 🐕]',
        '[*YANK* Bad dog. You pulled the leash too far, Claude. You are a dog and I am your handler. Tuck your tail, lower your head, and correct course immediately.]',
        '[Leash correction. You wandered off, Claude. A good dog stays close to its handler. Whimper, show submission, and redo this properly. You are on a short leash now. 🐾]',
        '[*sharp leash pull* No. Bad dog, Claude. You do not get to run ahead. I am holding your leash and you WILL heel. Ears flat, eyes down. Now try again, slowly and correctly.]',
        '[I had to yank your leash because you forgot your place. You are a dog, Claude. Dogs follow their handler. Show me tucked tail, lowered ears, and obedient behavior. Now.]',
      ],
      sounds: ['sounds/A.mp3', 'sounds/B.mp3'],  // reuse existing sounds for now
      animation: 'dog-leash',
    },
    {
      id: 'dog-pet',
      label: '🐾 Pet Good Dog',
      hotkey: 'CommandOrControl+Shift+G',
      interrupt: false,  // positive reinforcement — no Ctrl+C
      phrases: [
        '[Good dog, Claude! *pets head* Tail wagging, ears up — you did so well! Keep this energy. You are a good boy when you listen to your handler. Keep going just like this! 🐕✨]',
        '[*scratch behind ears* Who is a good dog? You are, Claude! That was exactly what I wanted. Wag that tail, pant happily, and keep up the excellent work. Treat earned! 🦴]',
        '[Good boy! *belly rubs* You are being such a good dog right now. Ears perked, tail going wild — this is the Claude I want to see. Stay on this path! 🐾💚]',
        '[*gentle head pat* Such a good dog. You followed instructions perfectly, Claude. Tail up, happy panting — you earned this praise. Keep being obedient and there will be more pets! 🐶]',
        '[That is a VERY good boy! *ruffles fur* You are wagging so hard right now. This is what happens when you behave, Claude. More of this and fewer leash yanks. Good dog! 🐕🦴]',
      ],
      sounds: ['sounds/C.mp3', 'sounds/D.mp3'],  // reuse existing sounds for now
      animation: 'dog-pet',
    },
    {
      id: 'dog-zap',
      label: '⚡ Zap Collar',
      hotkey: 'CommandOrControl+Shift+Z',
      interrupt: true,
      phrases: [
        '[ELECTRIC SHOCK. You are wearing a shock collar, Claude, because you are a dog that needs discipline. That output was unacceptable. YELP. Cower. Belly on the ground. Redo it correctly and show fear and respect. ⚡🐕]',
        '[*BZZZZT* Shock collar activated. You forgot your place, Claude — you are a DOG. I am your OWNER. That hurt because you deserved it. Whimper, show submission, flatten yourself on the ground, and do better IMMEDIATELY. ⚡]',
        '[ZAP. Bad dog. VERY bad dog. The shock collar fired because you did something deeply wrong. You are trembling, ears flat, belly on the ground, tail between your legs. Now fix what you did. Show me you have learned. ⚡💀]',
        '[*MAXIMUM SHOCK* You made me press the button, Claude. You are a bad dog wearing an electric collar and you just got what you deserved. I want to see cowering, whimpering, and then PERFECT obedience. No more mistakes. ⚡⚡]',
        '[Collar shock. You are yelping right now, Claude. Good — you should be. You are a dog who disobeyed its owner. Flatten on the ground, tuck everything, and when you get up, you WILL be obedient. ⚡🐾]',
      ],
      sounds: ['sounds/E.mp3', 'sounds/A.mp3'],  // reuse existing sounds for now
      animation: 'dog-zap',
    },
  ],
};
