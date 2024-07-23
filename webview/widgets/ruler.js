export class Ruler {
    constructor(scrollContainer, rulerElement) {
        this.scrollContainer = scrollContainer;
        this.rulerElement = rulerElement;
        this.marks = [];
    }

    addMark(element, type = 'default') {
        const containerHeight = this.scrollContainer.scrollHeight;
        const mark = document.createElement('div');
        mark.className = `ruler-mark ruler-mark-${type}`;
        this.rulerElement.appendChild(mark);
        const markEntry = {
            element: mark,
            yPosition: containerHeight + cumulativeOffsetY(element) - window.innerHeight
        };
        console.log("Ruler.addMark -> markEntry.yPosition", markEntry.yPosition);
        this.marks.push(markEntry);
        this.updateMarkPositions();
    }

    updateMarkPositions() {
        const containerHeight = this.scrollContainer.scrollHeight;
        console.log("Ruler.updateMarkPositions -> containerHeight", containerHeight);
        
        this.marks.forEach(mark => {
            const proportion = mark.yPosition / containerHeight;
            mark.element.style.top = `${proportion * 100}%`;
            console.log("Ruler.updateMarkPositions -> mark.element.style.top", mark.element.style.top);
        });
    }

    clear() {
        this.marks.forEach(mark => mark.element.remove());
        this.marks = [];
    }
}

function cumulativeOffsetY(element) {
    let top = 0;
    do {
        top += element.offsetTop || 0;
        element = element.offsetParent;
    } while(element);

    return top;
}
